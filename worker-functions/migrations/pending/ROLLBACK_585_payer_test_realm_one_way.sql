-- ROLLBACK_585_payer_test_realm_one_way.sql — par de rollback da migration 585 (trava de mão única, spec 077 D672).
--
-- Mora em `migrations/pending/` (sem número) porque o runner só lê `migrations/` sem recursão.
-- Só roda quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_585_payer_test_realm_one_way.sql
--
-- Volta o corpo e o comentário SIMÉTRICOS da 584 (D671), texto igual ao da 584. Nenhum dado muda; triggers e código
-- não mudam (leem a função pelo nome). Depois dele o paciente de teste volta a recusar pagador real. O ROLLBACK_584
-- (que apaga a função pelo mesmo nome) segue valendo depois deste.

CREATE OR REPLACE FUNCTION fn_077_payer_realm_matches_patient(p_patient_id uuid, p_provider_code text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_provider_code IS NULL
      OR COALESCE((SELECT pa.is_test FROM patients pa WHERE pa.id = p_patient_id), false)
       = COALESCE((SELECT p.is_test FROM insurance_providers p WHERE p.code = p_provider_code), false)
$$;

COMMENT ON FUNCTION fn_077_payer_realm_matches_patient(uuid, text) IS 'Pagador e paciente no mesmo realm (is_test), spec 077 D671. Dono da regra: os triggers trg_077_* e o PUT de cobertura leem daqui.';
