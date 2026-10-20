-- ROLLBACK_537_contracted_service_contract.sql — par de rollback da migration 537 (spec 058 Parte A).
-- ATENÇÃO: descarta os vínculos serviço -> contrato criados depois do deploy. Rodar antes dos ROLLBACK_536/535.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_537_contracted_service_contract.sql
DROP TRIGGER IF EXISTS trg_058_a_pcs_immutable_patient_country ON patient_contracted_services;
DROP FUNCTION IF EXISTS fn_058_a_pcs_immutable_patient_country();
DROP TABLE IF EXISTS contracted_service_contract;
DROP FUNCTION IF EXISTS fn_058_a_csc_guard();
DROP FUNCTION IF EXISTS fn_058_a_csc_immutable();
