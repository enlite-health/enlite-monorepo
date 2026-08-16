-- ROLLBACK da migration 278 (RLS grant-only → volta à policy da 274, com o ramo do claim).
--
-- Fora de migrations/ de propósito: o runner NÃO aplica isto. Uso manual:
--   psql "$DATABASE_URL" -f scripts/rollback/278_down.sql
-- Em PROD é EVENTO DE SEGURANÇA (lex C5 do ABAC): registrar quem/quando/por quê no diário
-- + log estruturado, e reabrir a change. Depois de rodar, para o runner não re-aplicar a
-- 278 no próximo boot, remover a linha em schema_migrations:
--   DELETE FROM schema_migrations WHERE filename = '278_rls_country_grant_only.sql';
-- (é o único caso em que mexer em schema_migrations à mão é legítimo — e só junto com
-- este script, testado no e2e da 1.9).

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
      FROM iam.user_groups ug
      JOIN users u
        ON u.firebase_uid = ug.user_id
       AND u.is_active IS TRUE
      JOIN iam.group_country_scopes gcs
        ON gcs.group_id = ug.group_id
       AND gcs.revoked_at IS NULL
      WHERE ug.user_id = current_setting('app.user_uid', true)
        AND gcs.country = patients.country
    )
  );
COMMENT ON POLICY patients_country_isolation ON patients IS
  'REVERTIDA para a policy da 274 (claim + grant) via scripts/rollback/278_down.sql.';
