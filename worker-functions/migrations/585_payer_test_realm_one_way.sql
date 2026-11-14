-- Migration 585: a trava do pagador de teste vira MÃO ÚNICA (spec 077, D672; corrige a 584, que entrou simétrica pela D671)
--
-- D672 (Gabriel, 14/11): pagador/contrato de teste (QA077) só pode ser ligado a paciente/serviço de teste; paciente de
-- teste PODE receber pagador real. A 584 seguia a D671 ("e o inverso") e recusava também pagador real em paciente de
-- teste: a tela do paciente de teste lista só pagadores reais, e o PUT de cobertura devolvia 422.
--
-- Muda SÓ o corpo de `fn_077_payer_realm_matches_patient` (mesmo nome, mesma assinatura e mesmos nomes de parâmetro:
-- o CREATE OR REPLACE substitui no lugar). Os 3 leitores não mudam e passam a ver a regra nova no mesmo instante:
--   trg_077_piv_test_realm e trg_077_csc_test_realm (584) e o PUT de cobertura
--   (`PatientInsuranceVerifiedRepository.replaceCodesForPatient`: `WHERE active AND fn_077_payer_realm_matches_patient($1, code)`).
-- Nome mantido de propósito: função nova exigiria trocar os 2 triggers e o SQL do PUT, e a revisão velha do
-- worker-functions (que segue servindo enquanto a nova sobe e roda esta migration no boot) chamaria uma função que não
-- existe mais (500 no PUT de cobertura) ou ficariam 2 donos da mesma regra. "O realm do pagador cabe no do paciente".
--
-- Predicado: recusa só pagador de teste em paciente real. Sem pagador (NULL) passa; ausente conta como real (nullsafe).
-- Só afrouxa (tudo que a 584 aceitava a 585 aceita): nenhuma linha existente fica inválida, nada é reescrito.
-- Idempotente (2x): CREATE OR REPLACE. Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_585_payer_test_realm_one_way.sql` (volta o corpo simétrico da 584).

CREATE OR REPLACE FUNCTION fn_077_payer_realm_matches_patient(p_patient_id uuid, p_provider_code text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_provider_code IS NULL
      OR NOT COALESCE((SELECT p.is_test FROM insurance_providers p WHERE p.code = p_provider_code), false)
      OR COALESCE((SELECT pa.is_test FROM patients pa WHERE pa.id = p_patient_id), false)
$$;

COMMENT ON FUNCTION fn_077_payer_realm_matches_patient(uuid, text) IS 'Pagador de teste só em paciente de teste; pagador real em qualquer paciente (spec 077 D672, migration 585; a 584 era simétrica, D671). Dono da regra: os triggers trg_077_* e o PUT de cobertura leem daqui.';
