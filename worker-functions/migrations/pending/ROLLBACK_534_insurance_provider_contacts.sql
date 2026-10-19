-- ROLLBACK_534_insurance_provider_contacts.sql — par de rollback da migration 534 (spec 058 Parte A).
-- ATENÇÃO: descarta os contatos cadastrados depois do deploy (dado pessoal cifrado; sem cópia em outro lugar).
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_534_insurance_provider_contacts.sql
DROP TABLE IF EXISTS insurance_provider_contacts;
DROP FUNCTION IF EXISTS fn_058_a_contacts_retired_at();
