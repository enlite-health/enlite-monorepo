-- ROLLBACK da migration 278 (RLS grant-only → volta à policy da 411, com o ramo do claim).
--
-- Fora de migrations/ de propósito: o runner NÃO aplica isto. Uso manual:
--   psql "$DATABASE_URL" -f scripts/rollback/278_down.sql   # ON_ERROR_STOP vem do próprio arquivo; abre e fecha a própria transação
-- Em PROD é EVENTO DE SEGURANÇA (lex C5 do ABAC): registrar quem/quando/por quê no diário
-- + log estruturado, e reabrir a change. A 278 vive em scripts/rollout/ (NÃO em
-- migrations/), então nunca há linha em schema_migrations para ela — nada a limpar; o
-- estado observável é o COMMENT ON POLICY.

\set ON_ERROR_STOP on
-- ATÔMICO: DROP + CREATE na mesma transação. Sem isso, se o CREATE falhar (função da 411 ausente),
-- o DROP já commitou e `patients` fica com RLS ligada e ZERO policy = deny-all no meio do incidente.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('iam.session_may_see_country(text,name,boolean)') IS NULL THEN
    RAISE EXCEPTION '[278_down] iam.session_may_see_country(text,name,boolean) não existe — a 411 não está aplicada neste banco; este rollback pressupõe a 411. Nada foi alterado.';
  END IF;
END
$$;
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
COMMIT;
