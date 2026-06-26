-- ============================================================
-- Migration 230: Kanban redesign — adiciona PRE_SCREENING ao funil
-- ============================================================
--
-- Contexto:
--   - INITIATED (Talentum) = candidato que entrou no formulário Talentum
--     → renomeado para PRE_SCREENING (mais descritivo)
--   - INICIADO (novo conceito UI) = quem CLICOU em postularse (pré-Talentum)
--     → representado por WJA stage=INVITED + source='manual' + worker_blocked_applications
--
-- FASE 1 (esta migration — aditiva):
--   - Adiciona PRE_SCREENING ao CHECK constraint (mantém INITIATED)
--   - Backfill: INITIATED → PRE_SCREENING
--   - Atualiza funnel_stage_precedence() com PRE_SCREENING
--
-- FASE 2 (futura migration):
--   - Remove INITIATED do CHECK constraint após confirmar 0 escritas em prod
--
-- Motivo de manter INITIATED no CHECK agora:
--   Rolling deploy — pods com código antigo podem gravar 'INITIATED' por alguns
--   segundos durante a transição. Se removermos agora, esses writes causam CHECK
--   violation. Remoção segura só após confirmar 0 pods com código antigo rodando.
-- ============================================================

BEGIN;

-- ── STEP 1: UPDATE defensivo — backfill INITIATED → PRE_SCREENING ────────────
-- Target: todos os WJAs com stage INITIATED que ainda não foram migrados.
-- Idempotente: segunda execução é no-op (nenhum INITIATED restante).
UPDATE worker_job_applications
SET application_funnel_stage = 'PRE_SCREENING',
    updated_at               = NOW()
WHERE application_funnel_stage = 'INITIATED';

-- ── STEP 2: Pré-check — confirmar backfill completo ───────────────────────────
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM worker_job_applications
  WHERE application_funnel_stage = 'INITIATED';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration 230 falhou: % WJAs ainda em INITIATED após backfill', bad_count;
  END IF;
END $$;

-- ── STEP 3a: Renomear constraint atual para _deprecated_ ──────────────────────
-- Idempotente: falha silenciosa se já foi substituído
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      RENAME CONSTRAINT worker_job_applications_application_funnel_stage_check
      TO worker_job_applications_application_funnel_stage_check_deprecated_20260626;
  END IF;
END $$;

-- ── STEP 3b: Adicionar novo CHECK com PRE_SCREENING + INITIATED (fase-1) ──────
-- INITIATED mantido intencionalmente — remoção na Fase 2 após rolling deploy.
-- PRE_SCREENING é o valor canônico novo; INITIATED aceito transitoriamente.
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
        'INITIATED',       -- FASE-1: mantido para rolling deploy; remover na Fase-2
        'PRE_SCREENING',   -- Novo canônico (antigo INITIATED após backfill)
        'IN_PROGRESS',
        'COMPLETED',
        'QUALIFIED',
        'IN_DOUBT',
        'CONFIRMED',
        'SELECTED',
        'REJECTED'
        -- REPROGRAM removido em F7.b (migration 195)
        -- RECHAZADO removido em F2 (migration 190)
        -- NOT_QUALIFIED removido em F3 (migration 191)
        -- PLACED removido em F7.a (migration 194)
      ));
  END IF;
END $$;

-- ── STEP 3c: Remover constraint _deprecated_ ──────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check_deprecated_20260626'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      DROP CONSTRAINT worker_job_applications_application_funnel_stage_check_deprecated_20260626;
  END IF;
END $$;

-- ── STEP 4: Atualizar funnel_stage_precedence() ───────────────────────────────
-- PRE_SCREENING no slot 1 (onde INITIATED estava).
-- INITIATED mantido no mapeamento (retorna -1 ou 1?) — conservador: manter precedência 1
-- para não quebrar lógica in-flight se algum pod antigo ainda tentar ler/comparar.
CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'       THEN 0
    WHEN 'INITIATED'     THEN 1   -- FASE-1: mantido; remoção na Fase-2
    WHEN 'PRE_SCREENING' THEN 1   -- Canônico novo (mesmo slot de INITIATED)
    WHEN 'IN_PROGRESS'   THEN 2
    WHEN 'COMPLETED'     THEN 3
    WHEN 'IN_DOUBT'      THEN 4
    WHEN 'QUALIFIED'     THEN 5
    WHEN 'CONFIRMED'     THEN 6
    WHEN 'SELECTED'      THEN 7
    WHEN 'REJECTED'      THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Precedência canônica do funil de candidaturas. '
  'Migration 230 (2026-06-26): PRE_SCREENING adicionado no slot 1 (substitui INITIATED). '
  'INITIATED mantido no slot 1 para fase-1 de rolling deploy; remoção na Fase-2. '
  'F7.b (migration 195): REPROGRAM removido. '
  'F7.a (migration 194): PLACED removido (0 linhas em prod). '
  'F3 (migration 191): NOT_QUALIFIED removido (auto-rejeição). '
  'F2 (migration 190): RECHAZADO removido (canonical=REJECTED). '
  'ANALYZED nunca esteve no CHECK de WJA — transporte interno do mapper Talentum.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 230 done: PRE_SCREENING adicionado ao CHECK + backfill INITIATED→PRE_SCREENING + funnel_stage_precedence atualizada.';
END $$;

COMMIT;
