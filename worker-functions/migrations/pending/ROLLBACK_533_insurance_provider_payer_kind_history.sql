-- ROLLBACK_533_insurance_provider_payer_kind_history.sql — par de rollback da migration 533 (spec 058 Parte A).
-- ATENÇÃO: descarta o rastro de reclassificação. Rodar antes do ROLLBACK_532.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_533_insurance_provider_payer_kind_history.sql
DROP TRIGGER IF EXISTS trg_058_a_payer_kind_history ON insurance_providers;
DROP TABLE IF EXISTS insurance_provider_payer_kind_history;
DROP FUNCTION IF EXISTS fn_058_a_payer_kind_history();
DROP FUNCTION IF EXISTS fn_058_a_payer_kind_history_imutavel();
