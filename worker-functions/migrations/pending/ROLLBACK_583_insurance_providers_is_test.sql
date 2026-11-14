-- ROLLBACK_583_insurance_providers_is_test.sql — par de rollback da migration 583 (pagador de teste, spec 077 D669).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão.
-- Só roda quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_583_insurance_providers_is_test.sql
--
-- ANTES de tirar a coluna, tira a massa de teste do catálogo: sem a coluna, o pagador de teste voltaria às listas como se
-- fosse real (D664). Ordem das FKs: vínculo -> termo -> contrato -> alias/contato -> pagador. A trilha de payer_kind (533)
-- é append-only e sem FK: a linha do pagador de teste fica lá (só identificador). Se algum paciente tiver o pagador de
-- teste em `patient_insurance_verified`, o DELETE do pagador falha pela FK (312) e o rollback para: tratar à mão.
-- Só toca linhas do pagador is_test.

-- a 583 só sai depois do guard da 584 (a função lê p.is_test); idempotente se a 584 nunca rodou.
DROP TRIGGER IF EXISTS trg_077_csc_test_realm ON contracted_service_contract;
DROP TRIGGER IF EXISTS trg_077_piv_test_realm ON patient_insurance_verified;
DROP FUNCTION IF EXISTS fn_077_csc_test_realm();
DROP FUNCTION IF EXISTS fn_077_piv_test_realm();
DROP FUNCTION IF EXISTS fn_077_payer_realm_matches_patient(uuid, text);

DELETE FROM contracted_service_contract
 WHERE contract_id IN (SELECT c.id FROM insurance_contracts c JOIN insurance_providers p ON p.code = c.provider_code WHERE p.is_test);
DELETE FROM insurance_contract_terms
 WHERE contract_id IN (SELECT c.id FROM insurance_contracts c JOIN insurance_providers p ON p.code = c.provider_code WHERE p.is_test);
DELETE FROM insurance_contracts WHERE provider_code IN (SELECT code FROM insurance_providers WHERE is_test);
DELETE FROM insurance_provider_aliases WHERE code IN (SELECT code FROM insurance_providers WHERE is_test);
DELETE FROM insurance_provider_contacts WHERE provider_code IN (SELECT code FROM insurance_providers WHERE is_test);
DELETE FROM insurance_providers WHERE is_test;

ALTER TABLE insurance_providers DROP COLUMN IF EXISTS is_test;
