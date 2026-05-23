-- Migration 190: Remove RECHAZADO from application_funnel_stage CHECK constraint
-- and update funnel_stage_precedence() accordingly.
--
-- Ground truth (prod, 2026-05-23):
--   worker_job_applications WHERE application_funnel_stage = 'RECHAZADO': 0 rows
--   REJECTED: 3 rows — canonical value, kept.
--   encuadres.resultado = 'RECHAZADO': 1830 rows — SEPARATE FIELD, untouched.
--
-- Part of F2 of the WJA/Encuadre consolidation plan
-- (docs/features/worker-job-applications/README.md).
--
-- Safe to run: no UPDATE needed (0 data rows affected on application_funnel_stage).
-- The CHECK constraint being replaced is effectively _deprecated_20260523 — it
-- accepted 'RECHAZADO' which is no longer a valid canonical value.
--
-- DEPLOY ORDER: code deploy MUST happen before this migration.
-- The use case HandleReminderResponseUseCase used to write 'RECHAZADO' to
-- application_funnel_stage; after the deploy it writes 'REJECTED' instead.
-- If this migration runs before the deploy, any concurrent run of that
-- use case violates the new CHECK constraint.

-- Replace the stale CHECK constraint (the old one is _deprecated_20260523):
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
    'NOT_QUALIFIED',
    'CONFIRMED',
    'REPROGRAM',
    'SELECTED',
    'REJECTED',
    'PLACED'
  ));

CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'       THEN 0
    WHEN 'INITIATED'     THEN 1
    WHEN 'IN_PROGRESS'   THEN 2
    WHEN 'COMPLETED'     THEN 3
    WHEN 'ANALYZED'      THEN 4
    WHEN 'IN_DOUBT'      THEN 4
    WHEN 'QUALIFIED'     THEN 5
    WHEN 'NOT_QUALIFIED' THEN 5
    WHEN 'REPROGRAM'     THEN 5
    WHEN 'CONFIRMED'     THEN 6
    WHEN 'SELECTED'      THEN 7
    WHEN 'PLACED'        THEN 7
    WHEN 'REJECTED'      THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Returns precedence integer for application_funnel_stage values. '
  'Higher = more advanced in the funnel. Unknown stages return -1. '
  'RECHAZADO removed in migration 190 — canonical value is REJECTED. '
  'IMMUTABLE — safe to use in index expressions and CASE conditions.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 190 done: RECHAZADO removed from application_funnel_stage CHECK; funnel_stage_precedence updated.';
END $$;
