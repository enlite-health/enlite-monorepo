-- ROLLBACK_584_payer_test_realm_guard.sql — par de rollback da migration 584 (guard de realm do pagador, spec 077 D671).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão.
-- Só roda quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_584_payer_test_realm_guard.sql
--
-- Tira só o guard (triggers e funções da 584); nenhum dado muda. Roda ANTES do ROLLBACK_583 (que tira a coluna que a
-- função lê). Depois dele, `insuranceErrorResponse.ts` só perde um código que ninguém levanta, e o PUT de cobertura
-- quebra (a função some): o rollback da 584 anda junto do revert do código da mesma PR.

DROP TRIGGER IF EXISTS trg_077_csc_test_realm ON contracted_service_contract;
DROP TRIGGER IF EXISTS trg_077_piv_test_realm ON patient_insurance_verified;
DROP FUNCTION IF EXISTS fn_077_csc_test_realm();
DROP FUNCTION IF EXISTS fn_077_piv_test_realm();
DROP FUNCTION IF EXISTS fn_077_payer_realm_matches_patient(uuid, text);
