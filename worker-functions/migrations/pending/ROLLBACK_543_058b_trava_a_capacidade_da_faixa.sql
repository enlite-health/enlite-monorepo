-- ROLLBACK_543_058b_trava_a_capacidade_da_faixa.sql — par de rollback da migration 543 (spec 058 Parte B). Rodar DEPOIS do ROLLBACK_544.
DROP TRIGGER IF EXISTS trg_058_b_assignment_capacity ON patient_itinerary_assignment;
DROP FUNCTION IF EXISTS fn_058_b_assignment_capacity();
COMMENT ON COLUMN patient_contracted_services.providers_needed IS NULL;
