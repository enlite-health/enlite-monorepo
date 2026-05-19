-- ============================================================
-- Migration 169: Application funnel stage history table + trigger
--
-- Problem: When a worker_job_application's application_funnel_stage changes,
-- the old value is overwritten without trace. No audit trail for
-- analytics, compliance, or debugging.
--
-- Creates:
--   1. worker_job_application_stage_history table
--   2. Trigger fn_log_application_stage_change() on worker_job_applications
--      AFTER INSERT OR UPDATE OF application_funnel_stage
-- ============================================================

-- 1. Create history table
CREATE TABLE IF NOT EXISTS worker_job_application_stage_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES worker_job_applications(id) ON DELETE CASCADE,
  field_name      VARCHAR(50) NOT NULL,
  old_value       VARCHAR(50),
  new_value       VARCHAR(50) NOT NULL,
  changed_by      VARCHAR(128),
  change_source   VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_application_stage_history_app
  ON worker_job_application_stage_history(application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_application_stage_history_field
  ON worker_job_application_stage_history(field_name, new_value);

-- 3. Trigger function
CREATE OR REPLACE FUNCTION fn_log_application_stage_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO worker_job_application_stage_history
      (application_id, field_name, old_value, new_value, changed_by)
    VALUES (NEW.id, 'application_funnel_stage', NULL, NEW.application_funnel_stage,
            current_setting('app.current_uid', true));
    RETURN NEW;
  END IF;

  IF OLD.application_funnel_stage IS DISTINCT FROM NEW.application_funnel_stage THEN
    INSERT INTO worker_job_application_stage_history
      (application_id, field_name, old_value, new_value, changed_by)
    VALUES (NEW.id, 'application_funnel_stage', OLD.application_funnel_stage, NEW.application_funnel_stage,
            current_setting('app.current_uid', true));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Attach trigger (drop/create for idempotency — project may run on Postgres pre-14)
DROP TRIGGER IF EXISTS trg_application_stage_history ON worker_job_applications;
CREATE TRIGGER trg_application_stage_history
  AFTER INSERT OR UPDATE OF application_funnel_stage ON worker_job_applications
  FOR EACH ROW EXECUTE FUNCTION fn_log_application_stage_change();
