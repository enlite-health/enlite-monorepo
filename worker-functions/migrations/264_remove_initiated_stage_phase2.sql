-- ============================================================
-- Migration 264: Kanban redesign — Fase-2: remove INITIATED do CHECK
-- ============================================================
--
-- Contexto:
--   Migration 230 (Fase-1, 2026-06-26) adicionou PRE_SCREENING ao CHECK,
--   fez backfill INITIATED→PRE_SCREENING, mas manteve INITIATED no CHECK
--   por causa do rolling deploy (pods antigos podiam ainda gravar INITIATED
--   durante a transição).
--
--   Esta migration (Fase-2) remove INITIATED definitivamente:
--     (a) troca o CHECK constraint — remove 'INITIATED', mantém os demais
--     (b) atualiza funnel_stage_precedence() — remove WHEN 'INITIATED' THEN 1
--
-- PRÉ-CONDIÇÃO OBRIGATÓRIA DE MERGE:
--   SELECT COUNT(*) FROM worker_job_applications WHERE application_funnel_stage='INITIATED'
--   deve retornar 0 em produção antes de fazer merge.
--   (O backfill da Fase-1 garante isso, mas confirmar antes de aplicar.)
--
-- Esta migration NÃO faz UPDATE de linhas — só altera a constraint e a função.
-- O guard trg_enforce_worker_registered não é disparado (sem INSERT/UPDATE em
-- application_funnel_stage via DML de dados).
--
-- Padrão de constraint renaming (lição crítica da fase-1):
--   Nome deprecated: wja_funnel_stage_chk_deprecated_20260704 (42 chars — bem abaixo de 63)
--   Postgres trunca identificadores em 63 chars; DROP por information_schema com nome
--   longo não casa — a busca é feita por nome exato. Manter nomes curtos previne isso.
-- ============================================================

BEGIN;

-- ── STEP 1a: Renomear constraint atual para _deprecated_ (idempotente) ──────
-- Se a constraint canônica existir, renomeia. Caso contrário (já foi renomeada
-- numa execução anterior incompleta), pula — a deprecated já existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_job_applications_application_funnel_stage_check'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      RENAME CONSTRAINT worker_job_applications_application_funnel_stage_check
      TO wja_funnel_stage_chk_deprecated_20260704;
  END IF;
END $$;

-- ── STEP 1b: Adicionar novo CHECK sem 'INITIATED' (idempotente) ─────────────
-- Só adiciona se a constraint canônica ainda não existir (evita erro em 2ª execução).
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
        'PRE_SCREENING',
        'IN_PROGRESS',
        'COMPLETED',
        'QUALIFIED',
        'IN_DOUBT',
        'CONFIRMED',
        'SELECTED',
        'REJECTED'
        -- 'INITIATED' removido definitivamente na Fase-2 (migration 264, 2026-07-04)
        -- 'REPROGRAM' removido em F7.b (migration 195)
        -- 'RECHAZADO' removido em F2 (migration 190)
        -- 'NOT_QUALIFIED' removido em F3 (migration 191)
        -- 'PLACED' removido em F7.a (migration 194)
      ));
  END IF;
END $$;

-- ── STEP 1c: Remover constraint _deprecated_ (idempotente) ──────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wja_funnel_stage_chk_deprecated_20260704'
      AND table_name = 'worker_job_applications'
  ) THEN
    ALTER TABLE worker_job_applications
      DROP CONSTRAINT wja_funnel_stage_chk_deprecated_20260704;
  END IF;
END $$;

-- ── STEP 2: Pós-check — garantir que não há linhas com INITIATED ─────────────
-- Não deve haver (backfill da mig 230 garante), mas aborta se encontrar.
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM worker_job_applications
  WHERE application_funnel_stage = 'INITIATED';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration 264 abortada: % WJAs ainda em INITIATED — execute a Migration 230 primeiro e confirme o backfill.', bad_count;
  END IF;
END $$;

-- ── STEP 3: Verificar que sobrou apenas UMA constraint de funnel_stage ────────
DO $$
DECLARE constraint_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO constraint_count
  FROM information_schema.table_constraints
  WHERE table_name = 'worker_job_applications'
    AND constraint_name LIKE '%funnel_stage%';
  IF constraint_count != 1 THEN
    RAISE EXCEPTION 'Migration 264: esperava 1 constraint de funnel_stage, encontrou %. Inspecionar pg_constraint.', constraint_count;
  END IF;
END $$;

-- ── STEP 4: Atualizar funnel_stage_precedence() — remove INITIATED ────────────
-- PRE_SCREENING permanece no slot 1. INITIATED não tem mais slot.
CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'       THEN 0
    WHEN 'PRE_SCREENING' THEN 1
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
  'Migration 264 (2026-07-04): INITIATED removido definitivamente (Fase-2). '
  'Migration 230 (2026-06-26): PRE_SCREENING adicionado no slot 1 (substitui INITIATED). '
  'F7.b (migration 195): REPROGRAM removido. '
  'F7.a (migration 194): PLACED removido (0 linhas em prod). '
  'F3 (migration 191): NOT_QUALIFIED removido (auto-rejeição). '
  'F2 (migration 190): RECHAZADO removido (canonical=REJECTED). '
  'ANALYZED nunca esteve no CHECK de WJA — transporte interno do mapper Talentum.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 264 done: INITIATED removido do CHECK + funnel_stage_precedence atualizada (Fase-2 completa).';
END $$;

COMMIT;
