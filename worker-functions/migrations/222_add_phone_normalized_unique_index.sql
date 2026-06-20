-- Migration 222: índice UNIQUE parcial de unicidade semântica em phone_normalized
--
-- PRÉ-REQUISITOS (ordem obrigatória):
--   1. Migration 219 aplicada (coluna phone_normalized + índice não-único).
--   2. Merge dos duplicados executado (dedup:execute) — senão a criação do
--      índice UNIQUE FALHA por duplicatas semânticas pré-existentes (~137 grupos).
--   3. Deploy do código de prevenção (WorkerRepository.create normaliza phone e
--      trata violação da constraint graciosamente). Ligar a unicidade ANTES do
--      código pode derrubar o cadastro de novos workers.
--
-- Por isso esta migration é SEPARADA da 219 e roda por último, junto do deploy.
-- IDEMPOTENTE: IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_phone_normalized_unique
  ON workers (phone_normalized)
  WHERE phone_normalized IS NOT NULL
    AND merged_into_id IS NULL;

COMMENT ON INDEX idx_workers_phone_normalized_unique IS
  'Unicidade semântica de telefone: impede novo INSERT/UPDATE que resultaria '
  'em phone_normalized duplicado entre workers ativos (merged_into_id IS NULL). '
  'Workers mergeados (soft-deleted) são excluídos da constraint.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 222 concluída: índice UNIQUE parcial idx_workers_phone_normalized_unique criado';
END $$;
