-- ROLLBACK_517_admission_050_live_tracking.sql — par de rollback da migration 517 (spec 050, F24).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Perde só o rastreio já gravado
-- (os eventos na trilha `admission_events` são só-acréscimo e ficam). Derrubar a coluna leva junto a CHECK nomeada.
ALTER TABLE admission_appointments
  DROP COLUMN IF EXISTS conference_start_seen_at,
  DROP COLUMN IF EXISTS conference_end_seen_at,
  DROP COLUMN IF EXISTS summary_fast_state,
  DROP COLUMN IF EXISTS summary_fast_reads,
  DROP COLUMN IF EXISTS summary_fast_last_count,
  DROP COLUMN IF EXISTS summary_fast_last_read_at;
