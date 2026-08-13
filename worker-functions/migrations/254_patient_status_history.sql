BEGIN;

-- ================================================================
-- Migration 254: patient status history table + trigger (Fase 4)
-- ================================================================
-- Context: App de Pacientes — rastreabilidade do funil de PACIENTES.
-- When a patient's `status` changes (SOLICITANTE → ADMISSION →
-- PENDING_ADMISSION → ACTIVE ...) the old value is overwritten with no
-- trace. Fase 4 needs the moment the patient ENTERED the current stage to
-- compute SLA de inatividade (hoursInStage / slaBreached) and to measure
-- funnel conversion over a period.
--
-- Creates:
--   1. patient_status_history table (append-only audit trail)
--   2. Trigger fn_log_patient_status_change() on patients UPDATE OF status
--   3. Backfill: one row per existing patient with new_value = current
--      status and created_at = patients.created_at, so `stageEnteredAt`
--      works for legacy rows that never transitioned through the trigger.
--
-- Idempotent: safe to re-run (IF NOT EXISTS, CREATE OR REPLACE, DROP
-- TRIGGER IF EXISTS, backfill guarded by NOT EXISTS).
-- Molde: migration 079 (worker_status_history).
-- ================================================================

-- ── 1. History table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  old_value     VARCHAR(50),
  new_value     VARCHAR(50) NOT NULL,
  change_source VARCHAR(100),   -- 'admin_panel' | 'kanban' | 'import' | 'backfill' | 'app' | NULL
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE patient_status_history IS
  'Append-only audit trail of patient.status transitions. Powers Fase 4 SLA (stageEnteredAt/hoursInStage/slaBreached) and funnel conversion metrics. Migration 254.';

-- Index for the SLA subquery: MAX(created_at) per patient for a given new_value.
CREATE INDEX IF NOT EXISTS idx_patient_status_history_patient
  ON patient_status_history (patient_id, created_at DESC);

-- ── 2. Trigger function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_log_patient_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source)
    VALUES (NEW.id, OLD.status, NEW.status,
            current_setting('app.change_source', true));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Attach trigger ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_patient_status_history ON patients;
CREATE TRIGGER trg_patient_status_history
  AFTER UPDATE OF status ON patients
  FOR EACH ROW EXECUTE FUNCTION fn_log_patient_status_change();

-- ── 4. Backfill (idempotent) ─────────────────────────────────────────────────
-- One row per existing patient so stageEnteredAt has a value for the legacy
-- population. created_at = patients.created_at (best available anchor: no
-- transition timestamp exists for rows that predate this table). Guarded by
-- NOT EXISTS so re-running the migration never duplicates.
INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, created_at)
SELECT p.id, NULL, p.status, 'backfill', p.created_at
  FROM patients p
 WHERE p.status IS NOT NULL
   AND p.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM patient_status_history psh WHERE psh.patient_id = p.id
   );

COMMIT;
