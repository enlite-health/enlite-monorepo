-- ROLLBACK_535_insurance_contracts.sql — par de rollback da migration 535 (spec 058 Parte A).
-- ATENÇÃO: descarta os contratos cadastrados depois do deploy. Rodar depois dos ROLLBACK_537 e ROLLBACK_536 (FK).
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_535_insurance_contracts.sql
DROP TABLE IF EXISTS insurance_contracts;
DROP FUNCTION IF EXISTS fn_058_a_contract_requires_payer_kind();
DROP FUNCTION IF EXISTS fn_058_a_contract_immutable_keys();
