-- Migration 225: worker_merge_snapshots — snapshot pré-merge para undo completo
--
-- CONTEXTO:
--   O WorkerPhoneMergeService executa reparent de FKs com estratégia upsert_delete
--   (tabelas como worker_documents, worker_payment_info, worker_job_applications).
--   Nessa estratégia, linhas do absorvido que colidem com o sobrevivente são
--   DELETADAS antes do reparent — sem snapshot, essas linhas se perdem para sempre.
--
--   Esta migration cria a tabela que armazena o estado completo do absorvido
--   (linha de workers + todas as linhas filhas) antes de qualquer mutação,
--   permitindo undoMerge() restaurar o estado exato pré-merge.
--
-- DESIGN DO PAYLOAD JSONB:
--   {
--     "worker_row": { ...colunas da tabela workers do absorvido... },
--     "fk_rows": {
--       "<table_name>": [ ...linhas do absorvido nessa tabela... ],
--       ...
--     }
--   }
--
-- IDEMPOTÊNCIA:
--   CREATE TABLE IF NOT EXISTS + índices IF NOT EXISTS — re-executar é seguro.

CREATE TABLE IF NOT EXISTS worker_merge_snapshots (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK para worker_merge_audit (1 snapshot por audit entry)
  merge_audit_id   BIGINT       NOT NULL REFERENCES worker_merge_audit(id),

  -- Worker que foi absorvido (sem FK pois após merge merged_into_id ≠ NULL)
  absorbed_worker_id UUID       NOT NULL,

  -- Payload completo: worker_row + fk_rows por tabela
  payload          JSONB        NOT NULL,

  -- Flag para idempotência do undo: TRUE após undoMerge() executar com sucesso
  undone_at        TIMESTAMPTZ,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE worker_merge_snapshots IS
  'Snapshot completo do worker absorvido (linha workers + linhas filhas FK) '
  'capturado ANTES de qualquer mutação do merge. '
  'Permite undoMerge() restaurar estado exato pré-merge sem perda de dados. '
  'payload.worker_row: todas as colunas do workers; '
  'payload.fk_rows: mapa {tabela: [linhas]}. '
  'undone_at: preenchido pelo undoMerge() — null = ainda não desfeito.';

COMMENT ON COLUMN worker_merge_snapshots.merge_audit_id IS
  'FK para worker_merge_audit.id — identifica o merge ao qual este snapshot pertence.';

COMMENT ON COLUMN worker_merge_snapshots.absorbed_worker_id IS
  'UUID do worker absorvido. Redundante com worker_merge_audit.absorbed_id mas '
  'facilita queries diretas sem JOIN.';

COMMENT ON COLUMN worker_merge_snapshots.payload IS
  'JSON com dois campos: worker_row (objeto com todas as colunas de workers) '
  'e fk_rows (objeto mapa tabela→array de linhas). '
  'Valores NULL de colunas de texto são preservados como null no JSON.';

COMMENT ON COLUMN worker_merge_snapshots.undone_at IS
  'Timestamp de quando o undoMerge() restaurou este snapshot. '
  'NULL = merge ainda ativo (não desfeito). '
  'Preenchido atomicamente na mesma transação do undo.';

-- Índice por merge_audit_id (lookup direto: dado o auditId, encontre o snapshot)
CREATE INDEX IF NOT EXISTS idx_worker_merge_snapshots_audit
  ON worker_merge_snapshots (merge_audit_id);

-- Índice por absorbed_worker_id (histórico de um worker específico)
CREATE INDEX IF NOT EXISTS idx_worker_merge_snapshots_absorbed
  ON worker_merge_snapshots (absorbed_worker_id);

-- Índice parcial: snapshots pendentes (não desfeitos) — usado pelo undoMerge
CREATE INDEX IF NOT EXISTS idx_worker_merge_snapshots_pending
  ON worker_merge_snapshots (merge_audit_id)
  WHERE undone_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE 'Migration 225 concluída: tabela worker_merge_snapshots criada';
END $$;
