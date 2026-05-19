-- ============================================================
-- Migration 166: adicionar 'ON_HOLD' ao CHECK constraint de job_postings.status
-- ============================================================
-- Necessário para suportar o status ClickUp 'en espera' (paciente ativo,
-- mas vaga pausada por razão operacional não-clínica). Distinto de
-- 'SUSPENDED' (suspensão clínica formal vinda de 'suspendido temporalmente').
--
-- Padrão de deprecação: renomear constraint atual para _deprecated_YYYYMMDD,
-- dropar e recriar com nome original ampliado. Operação aditiva ao set de
-- valores permitidos — não invalida nenhum row existente.
-- ============================================================

ALTER TABLE job_postings
  RENAME CONSTRAINT job_postings_status_check
  TO job_postings_status_check_deprecated_20260508;

ALTER TABLE job_postings
  DROP CONSTRAINT job_postings_status_check_deprecated_20260508;

ALTER TABLE job_postings ADD CONSTRAINT job_postings_status_check
  CHECK (status IN (
    'SEARCHING',
    'SEARCHING_REPLACEMENT',
    'RAPID_RESPONSE',
    'PENDING_ACTIVATION',
    'ACTIVE',
    'ON_HOLD',
    'SUSPENDED',
    'CLOSED'
  ));

DO $$ BEGIN RAISE NOTICE 'Migration 166: ON_HOLD adicionado ao CHECK de job_postings.status'; END $$;


