-- Migration 157: add complement column to patient_addresses
--
-- Motivation: SPRINT_CREATE_VACANCY_FORM_REFACTOR — the "Complemento de dirección" field
-- in the vacancy form was incorrectly bound to job_postings.daily_obs (which means daily
-- observations of the AT during work, unrelated to address). Address complement (Depto,
-- Piso, etc.) belongs to the address itself, not the vacancy.
--
-- ClickUp does not currently expose a dedicated complement field — info is embedded in
-- free-text "Domicilio Informado". Heuristic extraction from raw text proved unreliable
-- (false positives: bairros como "Bahia Blanca", "Floresta" matched).
--
-- Decision: column added now (additive migration), populated null. Recruiter will be able
-- to fill it via patient-edit UI in a future sprint. ClickUp mapper untouched
-- (project_clickup_deprecation: not worth investing in dying integration).

ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS complement TEXT;

COMMENT ON COLUMN patient_addresses.complement IS 'Complemento do endereço (Depto, Piso, andar). Preenchido manualmente via UI; ClickUp não tem campo equivalente.';
