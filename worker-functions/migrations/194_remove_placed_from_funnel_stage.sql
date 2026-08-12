-- ============================================================
-- Migration 194: F7.a — Remove PLACED do CHECK + limpa ANALYZED da função SQL
-- ============================================================
-- Parte do plano F7.a (docs/features/worker-job-applications/README.md).
-- ADR-001: docs/adr/001-encuadres-unique-worker-job-posting-constraint.md
-- ADR-002: docs/adr/002-wja-canonico-encuadres-deprecada.md
--
-- Pré-condições:
--   - Migrations 190 (RECHAZADO removido), 191 (NOT_QUALIFIED removido),
--     192 (consolidação encuadres), 193 (UNIQUE composta) já aplicadas
--   - Discovery DBA F7 (2026-05-24): 0 linhas com PLACED em prod, 0 transições
--
-- Escopo F7.a:
--   - PLACED: removido do CHECK + função SQL (0 linhas, 0 writers ativos pós-F6)
--   - ANALYZED: removido APENAS da função SQL (nunca esteve no CHECK de WJA)
--   - SELECTED MANTIDO (F4 fixou como coluna do Kanban)
--   - REPROGRAM MANTIDO (writer ativo em HandleReminderResponseUseCase — vai pra F7.b)
--
-- Padrão de deprecação (hook validate-migration.sh):
--   O constraint antigo é renomeado para _deprecated_20260524 antes de ser dropado.
--   A segunda execução é no-op porque o constraint _deprecated_ pode não existir.
--
-- Janela de execução: qualquer (sem writer ativo de PLACED desde F6 — sync deprecada).
-- Idempotente: segunda execução é no-op.
-- ============================================================

BEGIN;

-- 1. UPDATE preventivo defensivo (DBA confirmou 0 linhas, mas defesa em camadas)
UPDATE worker_job_applications
SET application_funnel_stage = 'SELECTED',
    updated_at = NOW()
WHERE application_funnel_stage = 'PLACED';

-- 2. Pré-check: zero linhas com PLACED após backfill defensivo
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM worker_job_applications
  WHERE application_funnel_stage = 'PLACED';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'F7.a falhou: % WJAs ainda em PLACED após backfill', bad_count;
  END IF;
END $$;

-- 3a. Renomear constraint antigo para _deprecated_20260524 (padrão de deprecação)
--     Idempotente: falha silenciosa se não existir (constraint já pode ter sido substituído)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      RENAME CONSTRAINT worker_job_applications_application_funnel_stage_check
      TO worker_job_applications_application_funnel_stage_check_deprecated_20260524;
  END IF;
END $$;

-- 3b. Adicionar novo CHECK sem PLACED (idempotente via IF NOT EXISTS emulado)
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
        'REPROGRAM',
        'SELECTED',
        'REJECTED'
      ));
  END IF;
END $$;

-- 3c. Remover constraint _deprecated_ (pode não existir em segunda execução — sem-op)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check_deprecated_20260524'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      DROP CONSTRAINT worker_job_applications_application_funnel_stage_check_deprecated_20260524;
  END IF;
END $$;

-- 4. CREATE OR REPLACE funnel_stage_precedence sem ANALYZED e PLACED
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
    WHEN 'REPROGRAM'   THEN 5
    WHEN 'CONFIRMED'   THEN 6
    WHEN 'SELECTED'    THEN 7
    WHEN 'REJECTED'    THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Returns precedence integer for application_funnel_stage. '
  'PLACED removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta). '
  'ANALYZED removido (nunca esteve no CHECK de WJA — transporte interno do mapper Talentum). '
  'NOT_QUALIFIED removido em F3 (191). RECHAZADO removido em F2 (190). '
  'REPROGRAM ainda no CHECK — remoção em F7.b após ADR-003 ampliado.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 194 done: PLACED removido do CHECK; ANALYZED + PLACED removidos de funnel_stage_precedence.';
END $$;

COMMIT;
