-- Migration 219: colunas de estado de espelhamento no AnaCare
--
-- CONTEXTO:
--   ana_care_id já existe (migration 014) — armazena o ID externo da enfermera.
--   Esta migration adiciona:
--     - ana_care_synced_at: timestamp da última sincronização bem-sucedida
--     - ana_care_sync_error: última mensagem de erro (HTTP status + body resumido)
--   E cria índice único parcial em ana_care_id (evita dois workers mapeados ao mesmo
--   ID externo; NULL excluído pois ainda não foi sincronizado).
--
-- PII-SAFETY:
--   ana_care_sync_error NÃO deve conter nome/documento/sexo decriptados — só status
--   HTTP e mensagem devolvida pela API externa. Responsabilidade de quem escreve.
--
-- IDEMPOTÊNCIA: todas as operações usam IF NOT EXISTS.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS ana_care_synced_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ana_care_sync_error  TEXT;

COMMENT ON COLUMN workers.ana_care_synced_at IS
  'Timestamp (UTC) da última sincronização bem-sucedida com a API AnaCare. '
  'NULL = nunca sincronizado. Atualizado pelo BackfillWorkerMirrorUseCase.';

COMMENT ON COLUMN workers.ana_care_sync_error IS
  'Último erro de sincronização com AnaCare (ex.: "HTTP 400: {email: already exists}"). '
  'PII-SAFE: nunca conter dados decriptados (nome, documento, sexo). '
  'Limpo ao sincronizar com sucesso.';

-- Índice único parcial: garante que dois workers distintos não apontem para o mesmo
-- ID externo no AnaCare. NULL (= não sincronizado) é excluído propositalmente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_ana_care_id_unique
  ON workers (ana_care_id)
  WHERE ana_care_id IS NOT NULL;
