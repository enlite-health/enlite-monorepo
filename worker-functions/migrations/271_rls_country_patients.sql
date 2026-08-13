-- 271: RLS por país em patients + satélites diretos — ENABLE, SEM FORCE (ABAC país Fase 1)
--
-- Deny-by-default no BANCO (D108): a policy vale para toda query presente e futura —
-- sobrevive a código esquecido (a classe de bug dos 7 gaps DISABLED de 10/08).
--
-- ⚠️ POR QUE SEM FORCE (verificado em prod 13/08): enlite_app é o OWNER destas tabelas
-- e não tem BYPASSRLS. Sem FORCE, o owner ignora as policies ⇒ comportamento de
-- prod/stg fica INALTERADO com esta migration. As policies só passam a valer quando a
-- connection virar para app_runtime/app_system (não-owner), atrás de
-- COUNTRY_RLS_ENABLED — tasks 4.1 (staging) e 4.3 (prod, por tabela). FORCE entra na
-- virada, nunca aqui.
--
-- Semântica da policy (patients):
--   1. contexto de sistema EXPLÍCITO (app.system_context, setado por wrapper de
--      cron/webhook/capability — task 3.3) vê tudo;
--   2. staff vê o próprio país (app.user_country, setado por request — task 3.1);
--   3. exceção: grant VIVO de grupo (group_country_scopes via user_groups, resolvido
--      a cada request — revogação tem efeito imediato).
--   Nenhuma variável setada ⇒ zero linhas (fail-closed).
--
-- Satélites (sem coluna country): a visibilidade SEGUE o paciente — policy por
-- EXISTS no pai; a subquery em patients é avaliada sob a MESMA RLS, então satélite
-- visível ⇔ paciente visível. Shortcut de sistema evita a subquery nos caminhos de job.

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patients_country_isolation ON patients;
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR country = current_setting('app.user_country', true)
    OR EXISTS (
      SELECT 1
      FROM user_groups ug
      JOIN group_country_scopes gcs
        ON gcs.group_id = ug.group_id
       AND gcs.revoked_at IS NULL
      WHERE ug.user_id = current_setting('app.user_uid', true)
        AND gcs.country = patients.country
    )
  );

-- ── Satélites diretos ────────────────────────────────────────────────────────────

ALTER TABLE patient_responsibles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_responsibles_follow_patient ON patient_responsibles;
CREATE POLICY patient_responsibles_follow_patient ON patient_responsibles
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_responsibles.patient_id)
  );

ALTER TABLE patient_addresses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_addresses_follow_patient ON patient_addresses;
CREATE POLICY patient_addresses_follow_patient ON patient_addresses
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_addresses.patient_id)
  );

ALTER TABLE patient_professionals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_professionals_follow_patient ON patient_professionals;
CREATE POLICY patient_professionals_follow_patient ON patient_professionals
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_professionals.patient_id)
  );

ALTER TABLE patient_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_status_history_follow_patient ON patient_status_history;
CREATE POLICY patient_status_history_follow_patient ON patient_status_history
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_status_history.patient_id)
  );

ALTER TABLE patient_chat_ids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_chat_ids_follow_patient ON patient_chat_ids;
CREATE POLICY patient_chat_ids_follow_patient ON patient_chat_ids
  FOR ALL
  USING (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_chat_ids.patient_id)
  );
