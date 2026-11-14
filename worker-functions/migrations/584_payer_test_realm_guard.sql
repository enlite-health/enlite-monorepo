-- Migration 584: guard de realm do pagador de teste nos escritores (spec 077, D671; D669 DP-15, D664, D665)
--
-- Regra (um dono só: `fn_077_payer_realm_matches_patient`): pagador e paciente no MESMO realm. Pagador de teste
-- (`insurance_providers.is_test`, 583) só se liga a paciente de teste (`patients.is_test`, 257), e pagador real só a
-- paciente real. Contrato e serviço não têm coluna própria (D516): o contrato herda o realm do pagador
-- (`insurance_contracts.provider_code`) e o serviço o do paciente (`patient_contracted_services.patient_id`).
-- Sem pagador (`provider_code` NULL: rótulo do ClickUp sem alias) não há o que comparar: passa.
--
-- Onde a regra age (as 2 junções paciente x pagador; todo escritor passa por elas, API, sync, script ou psql):
--   trg_077_piv_test_realm  BEFORE INSERT OR UPDATE OF patient_id, provider_code ON patient_insurance_verified
--   trg_077_csc_test_realm  BEFORE INSERT ON contracted_service_contract (UPDATE só marca o trio superseded_*: 537)
-- Recusa = P0001 `TEST_REALM_MISMATCH` (a MESSAGE é o código), que `insuranceErrorResponse.ts` (P0001_CODES) devolve 422.
-- O PUT de cobertura valida ANTES pela mesma função (catálogo do realm do paciente -> 422 INSURANCE_PROVIDER_UNKNOWN).
-- A criação de contrato (`insuranceContractTermWriter`) não é junção: o contrato nasce no realm do seu pagador.
-- Fora daqui (não é escrita destas junções): trocar `patients.is_test` ou `insurance_providers.is_test` depois do vínculo.
--
-- Nullsafe como `sameRealmAsVacancySql` (testRealmSql.ts): ausente conta como real. Sem SECURITY DEFINER (roda com o
-- papel e a RLS de quem escreve, que já enxerga o paciente). Nenhuma linha existente muda (prd 14/11: 0 linhas de
-- paciente de teste em patient_insurance_verified com código e 0 vínculos de serviço de paciente de teste).
-- Idempotente (2x): CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS. Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_584_payer_test_realm_guard.sql`.

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

CREATE OR REPLACE FUNCTION fn_077_piv_test_realm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT fn_077_payer_realm_matches_patient(NEW.patient_id, NEW.provider_code) THEN
    RAISE EXCEPTION 'TEST_REALM_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_077_piv_test_realm ON patient_insurance_verified;
CREATE TRIGGER trg_077_piv_test_realm
  BEFORE INSERT OR UPDATE OF patient_id, provider_code ON patient_insurance_verified
  FOR EACH ROW EXECUTE FUNCTION fn_077_piv_test_realm();

CREATE OR REPLACE FUNCTION fn_077_csc_test_realm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT fn_077_payer_realm_matches_patient(
       (SELECT s.patient_id FROM patient_contracted_services s WHERE s.id = NEW.contracted_service_id),
       (SELECT c.provider_code FROM insurance_contracts c WHERE c.id = NEW.contract_id)) THEN
    RAISE EXCEPTION 'TEST_REALM_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_077_csc_test_realm ON contracted_service_contract;
CREATE TRIGGER trg_077_csc_test_realm
  BEFORE INSERT ON contracted_service_contract
  FOR EACH ROW EXECUTE FUNCTION fn_077_csc_test_realm();
