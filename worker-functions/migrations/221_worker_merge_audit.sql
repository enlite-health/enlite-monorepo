-- Migration 221: worker_merge_audit — tabela de auditoria de merges de workers
--
-- CONTEXTO:
--   O WorkerPhoneMergeService (Track C parte 2) executa merges por categoria:
--     - firebase:        1 membro com auth_uid Firebase real → absorve sintéticos
--     - most_complete:   0 Firebase real → sobrevivente por completude/updated_at
--     - ghost:           email LIKE '%@enlite.import' com phone → mergeado no real
--
--   Esta tabela registra CADA merge individualmente para rastreabilidade,
--   permitindo auditoria, rollback manual e análise de qualidade de dados.
--
-- IDEMPOTÊNCIA:
--   CREATE TABLE IF NOT EXISTS + índice IF NOT EXISTS — re-executar é seguro.

CREATE TABLE IF NOT EXISTS worker_merge_audit (
  id               BIGSERIAL    PRIMARY KEY,

  -- Par do merge
  survivor_id      UUID         NOT NULL REFERENCES workers(id),
  absorbed_id      UUID         NOT NULL,   -- sem FK: absorbed já tem merged_into_id setado

  -- Identificador semântico do grupo
  phone_normalized TEXT         NOT NULL,

  -- Categoria do merge (determina a regra de seleção do sobrevivente)
  category         TEXT         NOT NULL
    CHECK (category IN ('firebase', 'most_complete', 'ghost')),

  -- Campos preenchidos no sobrevivente a partir do absorvido (COALESCE)
  -- Array de nomes de campo, ex: ["first_name_encrypted", "profession"]
  fields_filled    JSONB        NOT NULL DEFAULT '[]',

  -- Exceções registradas neste merge (campos divergentes não auto-sobrescritos)
  exceptions       JSONB        NOT NULL DEFAULT '[]',

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE worker_merge_audit IS
  'Trilha de auditoria de merges de workers duplicados executados pelo '
  'WorkerPhoneMergeService (Track C parte 2). '
  'Um registro por par (survivor, absorbed). '
  'category: firebase = sobrevivente por auth_uid real; '
  'most_complete = sobrevivente por completude; '
  'ghost = email de importação (@enlite.import) mergeado no real.';

COMMENT ON COLUMN worker_merge_audit.absorbed_id IS
  'UUID do worker absorvido (merged_into_id IS NOT NULL após o merge). '
  'Sem FK para permitir queries históricas mesmo após eventual limpeza.';

COMMENT ON COLUMN worker_merge_audit.fields_filled IS
  'Campos do absorvido que foram copiados ao sobrevivente via COALESCE '
  '(sobrevivente estava NULL, absorvido tinha valor). '
  'Formato: ["campo1", "campo2"]. Vazio [] quando o sobrevivente já tinha tudo.';

COMMENT ON COLUMN worker_merge_audit.exceptions IS
  'Campos legais/documentais divergentes que NÃO foram auto-sobrescritos. '
  'Requerem revisão humana. '
  'Formato: [{"field": "document_number_encrypted", "reason": "divergent"}].';

-- Índices de suporte para queries de auditoria
CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_survivor
  ON worker_merge_audit (survivor_id);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_absorbed
  ON worker_merge_audit (absorbed_id);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_phone
  ON worker_merge_audit (phone_normalized);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_category
  ON worker_merge_audit (category);

CREATE INDEX IF NOT EXISTS idx_worker_merge_audit_created_at
  ON worker_merge_audit (created_at DESC);

DO $$ BEGIN
  RAISE NOTICE 'Migration 221 concluída: tabela worker_merge_audit criada';
END $$;
