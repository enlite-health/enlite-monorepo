-- ================================================================
-- Migration 255: log initial patient status on INSERT
-- ================================================================
-- Migration 254 added patient_status_history + a trigger AFTER UPDATE OF status.
-- That covers transitions, but a patient created via INSERT (native lead/admin,
-- or ClickUp sync) got NO initial history row until its status first changed.
-- SLA falls back to patients.created_at, and the funnel counts current status,
-- so nothing broke — but the audit trail was incomplete. This adds an AFTER
-- INSERT trigger so every patient gets an initial history row (change_source='insert').
-- Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).
-- ================================================================

CREATE OR REPLACE FUNCTION fn_log_patient_status_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, created_at)
    VALUES (NEW.id, NULL, NEW.status, 'insert', NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_status_history_insert ON patients;

CREATE TRIGGER trg_patient_status_history_insert
  AFTER INSERT ON patients
  FOR EACH ROW
  EXECUTE FUNCTION fn_log_patient_status_insert();
