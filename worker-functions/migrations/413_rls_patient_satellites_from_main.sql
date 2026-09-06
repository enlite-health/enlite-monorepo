-- 413 — RLS de país nas 6 tabelas-satélite de paciente que o `main` criou depois da 271
-- (sync main→stage, 06/09/2026). Achado do e2e `country-rls-policies` ("invariante: TODA
-- tabela com FK para patients tem RLS ligada"), que ficou vermelho no merge: as specs 011-016
-- (admissão, cobertura, dispositivos, serviço contratado, diagnósticos CID-11, rótulos de
-- origem) nasceram no `main`, onde não há RLS, e o inventário da change ABAC já as listava
-- como "entram sob a policy da F1" (condição C-a.2 do `lex`, 03/09).
--
-- Mesmo molde da 271: ENABLE RLS + policy `<tabela>_follow_patient` = "linha visível se o
-- paciente-pai for visível" (ou contexto de sistema explícito). A decisão de país mora em
-- `patients` (policy da 411); as satélites só a seguem — nenhuma regra nova aqui.
--
-- Idempotente e re-rodável (DROP POLICY IF EXISTS). `job_postings` continua fora: tem
-- `country` próprio e é superfície de vaga (allowlist do teste), leva workers/vagas.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_contracted_services',
    'patient_device_types',
    'patient_diagnoses',
    'patient_insurance_verified',
    'patient_source_label_rejections',
    'patient_source_labels'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_follow_patient', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (
         (
           NULLIF(current_setting(''app.system_context'', true), '''') IS NOT NULL
           AND pg_has_role(current_user, ''app_system'', ''MEMBER'')
         )
         OR EXISTS (SELECT 1 FROM patients p WHERE p.id = %I.patient_id)
       )',
      t || '_follow_patient', t, t
    );
  END LOOP;
END
$$;
