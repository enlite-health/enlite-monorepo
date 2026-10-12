-- 517 — Rastreio do job ao vivo (spec 050, 4º passo, F24; R-48, R-49, R-51, R-52).
--
-- Seis colunas novas em `admission_appointments`. As duas primeiras guardam QUANDO o sistema FICOU SABENDO do início e do fim (a régua
-- permanente do atraso: `seen − real`). As quatro últimas são o estado do gatilho do resumo rápido (um por reunião; o histórico de
-- cada transição fica na trilha `admission_events`, não na linha).
--
-- O QUE `NULL` SIGNIFICA, coluna por coluna (uma coisa só cada; nenhuma linha antiga é preenchida, sem backfill):
--   conference_start_seen_at   NULL = o sistema ainda não gravou o início desta reunião (a 515 `conference_started_at` guarda o instante REAL).
--   conference_end_seen_at     NULL = o sistema ainda não gravou o fim desta reunião (a 503 `conference_ended_at` guarda o instante REAL).
--   summary_fast_state         NULL = o caminho rápido do resumo nunca foi armado para esta reunião.
--                              Valores: armed (esperando a transcrição) · fired (importou) · gave_up (caiu para a rede de 15 min)
--                              · cancelled (uma conferência nova abriu antes do resumo).
--   summary_fast_reads         NULL = o caminho rápido ainda não leu o Tactiq para esta reunião. O teto de 5 é POR REUNIÃO: rearmar
--                              depois de uma reabertura NÃO zera este contador.
--   summary_fast_last_count    NULL = nenhuma leitura do caminho rápido devolveu contagem de blocos desde que o gatilho foi armado
--                              (inclui "ainda não leu" e "a reunião não apareceu no Tactiq"). Rearmar volta para NULL.
--   summary_fast_last_read_at  NULL = o caminho rápido ainda não leu o Tactiq para esta reunião.
--
-- Aditiva: colunas anuláveis, sem DEFAULT e sem índice; nenhuma linha existente muda. Sem BEGIN/COMMIT próprio (o runner cuida disso).
-- Idempotente (2×): ADD COLUMN IF NOT EXISTS (a CHECK nomeada vai inline na coluna, então só entra junto com ela).
-- VOLTA: pending/ROLLBACK_517_*.sql (perde só o rastreio já gravado; a trilha `admission_events` fica).

ALTER TABLE admission_appointments
  ADD COLUMN IF NOT EXISTS conference_start_seen_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS conference_end_seen_at    TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS summary_fast_state        TEXT NULL
    CONSTRAINT admission_appointments_summary_fast_state_check
    CHECK (summary_fast_state IN ('armed', 'fired', 'gave_up', 'cancelled')),
  ADD COLUMN IF NOT EXISTS summary_fast_reads        INTEGER NULL,
  ADD COLUMN IF NOT EXISTS summary_fast_last_count   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS summary_fast_last_read_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN admission_appointments.conference_start_seen_at IS
  'Quando o sistema ficou sabendo do início (relógio do job). NULL = o início ainda não foi gravado.';
COMMENT ON COLUMN admission_appointments.conference_end_seen_at IS
  'Quando o sistema ficou sabendo do fim (relógio do job). NULL = o fim ainda não foi gravado.';
COMMENT ON COLUMN admission_appointments.summary_fast_state IS
  'Gatilho do resumo rápido: armed | fired | gave_up | cancelled. NULL = nunca armado.';
COMMENT ON COLUMN admission_appointments.summary_fast_reads IS
  'Leituras do Tactiq feitas pelo caminho rápido (teto 5 por reunião). NULL = nenhuma leitura ainda.';
COMMENT ON COLUMN admission_appointments.summary_fast_last_count IS
  'Contagem de blocos da última leitura rápida. NULL = nenhuma leitura devolveu contagem desde o último armar.';
COMMENT ON COLUMN admission_appointments.summary_fast_last_read_at IS
  'Instante da última leitura rápida. NULL = nenhuma leitura ainda.';
