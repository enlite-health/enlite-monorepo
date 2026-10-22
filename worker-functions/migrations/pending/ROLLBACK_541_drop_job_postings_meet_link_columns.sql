-- ROLLBACK_541_drop_job_postings_meet_link_columns.sql — par de rollback da migration 541 (spec 068, Fase B).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho, nunca pelo runner.
-- ⚠️ RECRIA A ESTRUTURA, NÃO O DADO: as 9 colunas voltam vazias (NULL). Os links de 122 vagas (medido em prd, 22/10/2026) só voltam
-- pelo backup automático 1792638000000 (22/10/2026 03:00Z) do Cloud SQL `enlite-ar-db`.
-- Tipos e defaults como nas migrations 098 (meet_link_N, meet_datetime_N) e 291 (meet_recurring_*, CHECKs e COMMENTs).
-- Nenhum código lê ou escreve estas colunas depois do PR A (#724); religar o código é outro PR.
BEGIN;

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS meet_link_1     TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_datetime_1 TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_link_2     TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_datetime_2 TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_link_3     TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_datetime_3 TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN job_postings.meet_link_1 IS 'Google Meet URL for interview slot 1';
COMMENT ON COLUMN job_postings.meet_datetime_1 IS 'Start datetime resolved from Google Calendar for slot 1';
COMMENT ON COLUMN job_postings.meet_link_2 IS 'Google Meet URL for interview slot 2';
COMMENT ON COLUMN job_postings.meet_datetime_2 IS 'Start datetime resolved from Google Calendar for slot 2';
COMMENT ON COLUMN job_postings.meet_link_3 IS 'Google Meet URL for interview slot 3';
COMMENT ON COLUMN job_postings.meet_datetime_3 IS 'Start datetime resolved from Google Calendar for slot 3';

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS meet_recurring_weekday SMALLINT DEFAULT NULL
    CHECK (meet_recurring_weekday IS NULL OR meet_recurring_weekday BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS meet_recurring_time TIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_recurring_link TEXT DEFAULT NULL;

COMMENT ON COLUMN job_postings.meet_recurring_weekday IS
  'Dia da semana da reunión de presentación recorrente (0=domingo … 6=sábado). NULL = sem recorrência.';
COMMENT ON COLUMN job_postings.meet_recurring_time IS
  'Hora LOCAL da reunião recorrente, no fuso de job_postings.timezone (mig 180). Nunca UTC.';
COMMENT ON COLUMN job_postings.meet_recurring_link IS
  'Sala do Google Meet da reunião recorrente (https://meet.google.com/xxx-xxxx-xxx).';

-- Os três andam juntos: recorrência sem hora ou sem sala não é ofertável.
ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_meet_recurring_complete;
ALTER TABLE job_postings
  ADD CONSTRAINT job_postings_meet_recurring_complete CHECK (
    (meet_recurring_weekday IS NULL AND meet_recurring_time IS NULL AND meet_recurring_link IS NULL)
    OR (meet_recurring_weekday IS NOT NULL AND meet_recurring_time IS NOT NULL AND meet_recurring_link IS NOT NULL)
  );

COMMIT;
