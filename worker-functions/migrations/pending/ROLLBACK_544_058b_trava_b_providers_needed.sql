-- ROLLBACK_544_058b_trava_b_providers_needed.sql — par de rollback da migration 544 (spec 058 Parte B). Rodar ANTES do ROLLBACK_543.
DROP TRIGGER IF EXISTS trg_058_b_pcs_providers_needed ON patient_contracted_services;
DROP FUNCTION IF EXISTS fn_058_b_pcs_providers_needed();
