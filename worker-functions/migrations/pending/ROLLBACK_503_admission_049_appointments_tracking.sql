-- ROLLBACK_503_admission_049_appointments_tracking.sql — par de rollback da migration 503 (spec 049).
-- Rodar DEPOIS dos rollbacks 504-507 (506 tem FK para admission_appointments). Perde código ADM, rastreio e estado da importação.
DROP INDEX IF EXISTS uq_admission_appointments_code;
ALTER TABLE admission_appointments
  DROP CONSTRAINT IF EXISTS admission_appointments_code_format,
  DROP CONSTRAINT IF EXISTS admission_appointments_created_via_check,
  DROP CONSTRAINT IF EXISTS admission_appointments_import_status_check;
ALTER TABLE admission_appointments
  DROP COLUMN IF EXISTS admission_code,
  DROP COLUMN IF EXISTS created_via,
  DROP COLUMN IF EXISTS created_by_uid,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by_uid,
  DROP COLUMN IF EXISTS meet_space_name,
  DROP COLUMN IF EXISTS conference_ended_at,
  DROP COLUMN IF EXISTS import_status,
  DROP COLUMN IF EXISTS import_attempts;
