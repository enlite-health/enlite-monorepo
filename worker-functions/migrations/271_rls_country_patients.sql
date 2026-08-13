-- 271: RLS por país em patients + satélites — ENABLE, SEM FORCE (ABAC país Fase 1)
--
-- Deny-by-default no BANCO (D108): a policy vale para toda query presente e futura —
-- sobrevive a código esquecido (a classe de bug dos 7 gaps DISABLED de 10/08).
--
-- ⚠️ POR QUE SEM FORCE (verificado em prod 13/08): enlite_app é o OWNER destas tabelas
-- e não tem BYPASSRLS. Sem FORCE, o owner ignora as policies ⇒ o comportamento do APP
-- em prod/stg fica INALTERADO com esta migration. As policies só passam a valer quando
-- a connection virar para app_runtime/app_system (não-owner), atrás de
-- COUNTRY_RLS_ENABLED — tasks 4.1 (staging) e 4.3 (prod, por tabela). FORCE entra na
-- virada, nunca aqui. O e2e trava relforcerowsecurity=false nas tabelas desta leva.
--
-- ⚠️ CONEXÕES OPERACIONAIS NÃO-OWNER: a partir desta migration, uma sessão ad-hoc como
-- outro usuário (ex.: `postgres` via cloud-sql-proxy — cloudsqlsuperuser NÃO é
-- superuser e NÃO tem BYPASSRLS) vê ZERO linhas nestas tabelas sem setar contexto.
-- Não é perda de dado: é a RLS fail-closed. Para inspeção ad-hoc, conectar como
-- enlite_app (owner) ou setar `SELECT set_config('app.system_context','ops:<motivo>',
-- false)` numa role membro de app_system.
--
-- Semântica da policy (patients):
--   1. contexto de SISTEMA = role membro de app_system E app.system_context setado
--      (wrapper de cron/webhook/capability — task 3.3). O gate por role fecha o furo
--      de um set_config esquecido/injetado no caminho de staff (app_runtime com o GUC
--      setado continua confinada ao país);
--   2. staff vê o próprio país (app.user_country, setado por request — task 3.1);
--   3. exceção: grant VIVO de grupo (group_country_scopes via user_groups, resolvido
--      a cada request — revogação tem efeito imediato) e usuário AINDA ATIVO
--      (offboarding por users.is_active=false corta o grant na hora, mesmo que a
--      linha de user_groups tenha ficado para trás).
--   Nenhuma variável setada ⇒ zero linhas (fail-closed).
--
-- Satélites (sem coluna country): a visibilidade SEGUE o paciente — policy por
-- EXISTS no pai; a subquery em patients é avaliada sob a MESMA RLS, então satélite
-- visível ⇔ paciente visível. Cobertura derivada do CATÁLOGO (toda tabela com FK
-- para patients), não de memória — e o e2e trava a invariante para tabelas futuras.
-- FORA desta leva, deliberadamente: job_postings (tem coluna country própria e é
-- superfície de vaga, não dossiê clínico — entra na leva workers/vagas, task 4.3).

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patients_country_isolation ON patients;
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR country = current_setting('app.user_country', true)
    OR EXISTS (
      SELECT 1
      FROM user_groups ug
      JOIN users u
        ON u.firebase_uid = ug.user_id
       AND u.is_active IS TRUE
      JOIN group_country_scopes gcs
        ON gcs.group_id = ug.group_id
       AND gcs.revoked_at IS NULL
      WHERE ug.user_id = current_setting('app.user_uid', true)
        AND gcs.country = patients.country
    )
  );

-- ── Satélites: toda tabela com FK para patients ─────────────────────────────────
-- Lista conferida no catálogo (pg_constraint → patients) em 13/08:
--   patient_responsibles · patient_addresses · patient_professionals ·
--   patient_status_history · patient_chat_ids · patient_field_overrides_audit ·
--   patient_chat_id_changes · admission_appointments · vacancy_relink_audit
-- (patient_chat_id_changes referencia por coluna patient_id sem FK — incluída.)

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_responsibles',
    'patient_addresses',
    'patient_professionals',
    'patient_status_history',
    'patient_chat_ids',
    'patient_field_overrides_audit',
    'patient_chat_id_changes',
    'admission_appointments'
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

-- vacancy_relink_audit tem DUAS pontas de paciente (old/new) — visível só se TODA
-- ponta referenciada for visível (a mais restritiva vence).
ALTER TABLE vacancy_relink_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vacancy_relink_audit_follow_patient ON vacancy_relink_audit;
CREATE POLICY vacancy_relink_audit_follow_patient ON vacancy_relink_audit
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR (
      (old_patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = vacancy_relink_audit.old_patient_id))
      AND (new_patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = vacancy_relink_audit.new_patient_id))
    )
  );
