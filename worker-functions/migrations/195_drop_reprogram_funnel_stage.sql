-- ============================================================
-- Migration 195: F7.b — Remove REPROGRAM do CHECK + migra writer para awaiting_reschedule
-- ============================================================
-- Parte do plano F7.b (docs/adr/003-naming-wja-vs-encuadre.md).
--
-- Pré-condições:
--   - Migration 194 (F7.a) já aplicada — constraint atual: worker_job_applications_application_funnel_stage_check
--   - Discovery DBA (2026-05-25): 0 linhas com REPROGRAM em prod (migration 123 aplicada)
--   - HandleReminderResponseUseCase.handleRescheduleYes já migrado (F7.b deploy)
--     → agora escreve interview_response='awaiting_reschedule', funnel_stage permanece CONFIRMED
--
-- Escopo F7.b:
--   - REPROGRAM: removido do CHECK constraint + função SQL
--   - Workers que reagendam agora vivem em CONFIRMED + interview_response='awaiting_reschedule'
--   - Distinguidor: interview_meet_link=NULL (slot liberado, aguarda novo link)
--
-- Janela de execução: APÓS deploy do código F7.b (HandleReminderResponseUseCase migrado).
-- Idempotente: segunda execução é no-op (padrão migration 194).
-- ============================================================

BEGIN;

-- ── STEP 1: UPDATE defensivo (safety guard) ────────────────────────────────
-- 0 rows esperadas (migration 123 + 0 writers ativos), mas defesa em camadas
UPDATE worker_job_applications
SET application_funnel_stage = 'CONFIRMED',
    interview_response       = 'awaiting_reschedule',
    updated_at               = NOW()
WHERE application_funnel_stage = 'REPROGRAM';

-- ── STEP 2: Pré-check: zero linhas com REPROGRAM após backfill defensivo ──
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM worker_job_applications
  WHERE application_funnel_stage = 'REPROGRAM';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'F7.b falhou: % WJAs ainda em REPROGRAM após backfill', bad_count;
  END IF;
END $$;

-- ── STEP 3a: Renomear constraint antigo para _deprecated_20260525 ──────────
--     Idempotente: falha silenciosa se já foi substituído
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      RENAME CONSTRAINT worker_job_applications_application_funnel_stage_check
      TO worker_job_applications_application_funnel_stage_check_deprecated_20260525;
  END IF;
END $$;

-- ── STEP 3b: Adicionar novo CHECK sem REPROGRAM ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check'
      AND table_name = 'worker_job_applications'
  ) THEN
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
        'SELECTED',
        'REJECTED'
        -- REPROGRAM removido em F7.b (migration 195) — ADR-003
        -- RECHAZADO removido em F2 (migration 190)
        -- NOT_QUALIFIED removido em F3 (migration 191)
        -- PLACED removido em F7.a (migration 194)
      ));
  END IF;
END $$;

-- ── STEP 3c: Remover constraint _deprecated_ ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check_deprecated_20260525'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      DROP CONSTRAINT worker_job_applications_application_funnel_stage_check_deprecated_20260525;
  END IF;
END $$;

-- ── STEP 4: Atualizar funnel_stage_precedence() ───────────────────────────
CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'     THEN 0
    WHEN 'INITIATED'   THEN 1
    WHEN 'IN_PROGRESS' THEN 2
    WHEN 'COMPLETED'   THEN 3
    WHEN 'IN_DOUBT'    THEN 4
    WHEN 'QUALIFIED'   THEN 5
    WHEN 'CONFIRMED'   THEN 6
    WHEN 'SELECTED'    THEN 7
    WHEN 'REJECTED'    THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Precedência canônica do funil de candidaturas. '
  'F7.b (migration 195, 2026-05-25): REPROGRAM removido — worker reschedule agora vive em '
  'CONFIRMED + interview_response=awaiting_reschedule + meet_link=NULL (ADR-003). '
  'F7.a (migration 194): PLACED removido (0 linhas em prod, sync F6 morta). '
  'F3 (migration 191): NOT_QUALIFIED removido (auto-rejeição). '
  'F2 (migration 190): RECHAZADO removido (canonical=REJECTED). '
  'ANALYZED nunca esteve no CHECK de WJA — transporte interno do mapper Talentum.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 195 done: REPROGRAM removido do CHECK e de funnel_stage_precedence (F7.b).';
END $$;

COMMIT;
