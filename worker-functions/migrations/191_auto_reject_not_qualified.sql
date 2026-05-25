-- Migration 191: Auto-reject NOT_QUALIFIED → REJECTED in application_funnel_stage
--
-- Part of F3 of the WJA/Encuadre consolidation plan
-- (docs/features/worker-job-applications/README.md).
--
-- Three steps in one migration (idempotente):
--   1. Backfill: UPDATE existing NOT_QUALIFIED rows to REJECTED (2463 rows in prod 2026-05-23)
--      Trigger trg_application_stage_history (migration 169) captures each row.
--   2. DROP + ADD CHECK constraint removing NOT_QUALIFIED from allowed values.
--   3. CREATE OR REPLACE funnel_stage_precedence() removing WHEN 'NOT_QUALIFIED'.
--
-- DEPLOY ORDER:
--   - Code deploy first (use case stops persisting NOT_QUALIFIED — auto-rejects to REJECTED)
--   - Then this migration runs in prod
--   - If migration runs first, concurrent webhook executions will fail CHECK violation

-- Step 1: backfill
-- Trigger trg_enforce_worker_registered (migration 183) valida workers.status='REGISTERED'
-- na clausula UPDATE. Migration retroage rows historicas — workers podem ter status
-- INCOMPLETE_REGISTER hoje. Desativamos o trigger temporariamente apenas para este UPDATE.
ALTER TABLE worker_job_applications DISABLE TRIGGER trg_enforce_worker_registered;

UPDATE worker_job_applications
SET application_funnel_stage = 'REJECTED',
    updated_at = NOW()
WHERE application_funnel_stage = 'NOT_QUALIFIED';

ALTER TABLE worker_job_applications ENABLE TRIGGER trg_enforce_worker_registered;

-- Step 2: CHECK constraint (old one is _deprecated_20260523 — accepted NOT_QUALIFIED)
ALTER TABLE worker_job_applications
  DROP CONSTRAINT IF EXISTS worker_job_applications_application_funnel_stage_check; -- replaces _deprecated_20260523 CHECK

ALTER TABLE worker_job_applications
  ADD CONSTRAINT worker_job_applications_application_funnel_stage_check
  CHECK (application_funnel_stage IN (
    'INVITED',
    'INITIATED',
    'IN_PROGRESS',
    'COMPLETED',
    'QUALIFIED',
    'IN_DOUBT',
    'CONFIRMED',
    'REPROGRAM',
    'SELECTED',
    'REJECTED',
    'PLACED'
  ));

-- Step 3: precedência canônica
CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'     THEN 0
    WHEN 'INITIATED'   THEN 1
    WHEN 'IN_PROGRESS' THEN 2
    WHEN 'COMPLETED'   THEN 3
    WHEN 'IN_DOUBT'    THEN 4
    WHEN 'QUALIFIED'   THEN 5
    WHEN 'REPROGRAM'   THEN 5
    WHEN 'CONFIRMED'   THEN 6
    WHEN 'SELECTED'    THEN 7
    WHEN 'PLACED'      THEN 7
    WHEN 'REJECTED'    THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Returns precedence integer for application_funnel_stage. Higher = more advanced. '
  'NOT_QUALIFIED removed in migration 191 — auto-rejected to REJECTED.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 191 done: NOT_QUALIFIED rows backfilled to REJECTED; CHECK and precedence updated.';
END $$;
