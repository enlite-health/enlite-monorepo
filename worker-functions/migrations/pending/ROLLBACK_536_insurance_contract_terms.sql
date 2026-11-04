-- ROLLBACK_536_insurance_contract_terms.sql — par de rollback da migration 536 (spec 058 Parte A).
-- ATENÇÃO: descarta os termos (valor-hora/imposto) cadastrados depois do deploy. Rodar depois do ROLLBACK_537.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_536_insurance_contract_terms.sql
DROP TABLE IF EXISTS insurance_contract_terms;
DROP FUNCTION IF EXISTS fn_058_a_term_immutable();
