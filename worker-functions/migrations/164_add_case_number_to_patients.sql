-- ============================================================
-- Migration 164: patients.case_number — identificador PII-safe operacional
-- ============================================================
-- Origem: ClickUp custom field "Caso Número" (ex: "766").
-- A operação usa "Caso #766" em comunicação interna (WhatsApp, planilhas,
-- audits) em vez do nome do paciente, por proteção de PII.
--
-- UNIQUE só entre patients ativos: permite reuso histórico de números
-- (paciente deletado libera o número), bloqueia duplicidade ativa.
-- Depende de patients.deleted_at (criado em migration 163).
-- ============================================================

ALTER TABLE patients ADD COLUMN IF NOT EXISTS case_number INTEGER;

COMMENT ON COLUMN patients.case_number IS
  'Identificador PII-safe operacional (ClickUp "Caso Número"). Usado em comunicação interna no lugar do nome.';

CREATE UNIQUE INDEX IF NOT EXISTS patients_case_number_active_unique
  ON patients(case_number)
  WHERE deleted_at IS NULL AND case_number IS NOT NULL;

DO $$ BEGIN RAISE NOTICE 'Migration 164: patients.case_number adicionado com UNIQUE parcial em patients ativos'; END $$;
