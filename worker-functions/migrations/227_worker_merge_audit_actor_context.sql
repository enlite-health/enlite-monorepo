-- Migration 227: worker_merge_audit — colunas de ATOR, CONTEXTO e OVERRIDES
--
-- CONTEXTO:
--   Auditoria detalhada de merges de workers (Centro de Duplicados). A versão
--   original (mig 221) só guardava o par survivor/absorbed + fields_filled, mas
--   NÃO registrava QUEM executou nem COMO. Como não confiamos cegamente no admin
--   que faz a unificação, esta migration adiciona o rastro completo:
--     - QUEM: executed_by (uid) + executed_by_email (denormalizado no momento)
--     - DE ONDE: source (fila/importados/manual/auto_batch), ip_address, user_agent, request_id
--     - COMO: confirmed_same_person (override manual de 2 contas reais),
--             field_choices (o que o admin mandou) + applied_overrides (o que de
--             fato foi sobrescrito de uma conta na outra),
--             survivor_email/absorbed_email (leitura forense rápida)
--     - DESFAZER: undone_by/undone_by_email/undone_at + ip/user_agent/request_id do undo
--
--   Os mesmos dados vão pro Cloud Logging (fora do alcance de quem tem acesso ao
--   banco) — esta tabela é a cópia consultável; o log é a cópia à prova de adulteração.
--
-- IDEMPOTÊNCIA: ADD COLUMN IF NOT EXISTS + índice IF NOT EXISTS — re-executar é seguro.
-- ADITIVA: nenhuma coluna/constraint removida.

ALTER TABLE worker_merge_audit
  -- Ator (QUEM)
  ADD COLUMN IF NOT EXISTS executed_by           TEXT,
  ADD COLUMN IF NOT EXISTS executed_by_email     TEXT,
  -- Contexto (DE ONDE / COMO)
  ADD COLUMN IF NOT EXISTS source                TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_same_person BOOLEAN,
  ADD COLUMN IF NOT EXISTS ip_address            TEXT,
  ADD COLUMN IF NOT EXISTS user_agent            TEXT,
  ADD COLUMN IF NOT EXISTS request_id            TEXT,
  -- O que o admin escolheu e o que foi de fato sobrescrito
  ADD COLUMN IF NOT EXISTS field_choices         JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS applied_overrides     JSONB NOT NULL DEFAULT '[]',
  -- Leitura forense rápida (denormalizado no momento do merge)
  ADD COLUMN IF NOT EXISTS survivor_email        TEXT,
  ADD COLUMN IF NOT EXISTS absorbed_email        TEXT,
  -- Auditoria do DESFAZER (undo)
  ADD COLUMN IF NOT EXISTS undone_by             TEXT,
  ADD COLUMN IF NOT EXISTS undone_by_email       TEXT,
  ADD COLUMN IF NOT EXISTS undone_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS undo_ip_address       TEXT,
  ADD COLUMN IF NOT EXISTS undo_user_agent       TEXT,
  ADD COLUMN IF NOT EXISTS undo_request_id       TEXT;

COMMENT ON COLUMN worker_merge_audit.executed_by IS
  'uid (Firebase) do admin que executou o merge. "system" para merges automáticos em lote.';
COMMENT ON COLUMN worker_merge_audit.executed_by_email IS
  'Email do admin resolvido no momento do merge (denormalizado — robusto a remoção futura do usuário).';
COMMENT ON COLUMN worker_merge_audit.source IS
  'Fluxo que originou o merge: fila (colisão por telefone), imported (aba Importados), '
  'manual (Unificar manualmente), auto_batch (limpeza automática).';
COMMENT ON COLUMN worker_merge_audit.confirmed_same_person IS
  'true quando o admin unificou 2+ contas REAIS pela fusão manual e confirmou '
  'explicitamente "es la misma persona" (ação de maior risco — sempre revisar).';
COMMENT ON COLUMN worker_merge_audit.field_choices IS
  'Mapa cru enviado pelo admin no modo avançado: { campo: id_da_conta_vencedora }.';
COMMENT ON COLUMN worker_merge_audit.applied_overrides IS
  'Campos que o admin de fato SOBRESCREVEU copiando da conta absorvida para a '
  'principal. Formato: [{"field":"document_number_encrypted","from_account_id":"<uuid>"}].';

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_executed_by
  ON worker_merge_audit (executed_by);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_source
  ON worker_merge_audit (source);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_undone_by
  ON worker_merge_audit (undone_by);

DO $$ BEGIN
  RAISE NOTICE 'Migration 227 concluída: worker_merge_audit ganhou ator/contexto/overrides/undo';
END $$;
