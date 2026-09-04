-- ROLLBACK da migration 278 (RLS grant-only → volta à policy da 411, com o ramo do claim).
--
-- Fora de migrations/ de propósito: o runner NÃO aplica isto. Uso manual:
--   psql "$DATABASE_URL" -f scripts/rollback/278_down.sql
-- Em PROD é EVENTO DE SEGURANÇA (lex C5 do ABAC): registrar quem/quando/por quê no diário
-- + log estruturado, e reabrir a change. A 278 vive em scripts/rollout/ (NÃO em
-- migrations/), então nunca há linha em schema_migrations para ela — nada a limpar; o
-- estado observável é o COMMENT ON POLICY.

DROP POLICY IF EXISTS patients_country_isolation ON patients;
-- Texto IDÊNTICO ao da 411 (claim + grant pela função SECDEF com p_honor_claim = true, gate de role, recusa em voz alta).
-- Se a 411 mudar, este arquivo muda junto — é a mesma policy em três lugares (411 explica).
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR iam.session_may_see_country(patients.country, current_user, true)
  );
COMMENT ON POLICY patients_country_isolation ON patients IS
  'REVERTIDA para a policy da 411 (claim + grant pela função iam.session_may_see_country) via scripts/rollback/278_down.sql.';
