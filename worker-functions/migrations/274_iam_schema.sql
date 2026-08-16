-- 274: schema `iam` — as tabelas de identidade/permissão saem de `public` (D115, extração p/ BFF)
--
-- POR QUÊ: o sistema de permissões (change painel-grupos-permissao) vai virar um
-- serviço próprio quando o worker-functions for desmontado em microserviços. Para a
-- extração ser só deploy, as tabelas do módulo ganham schema PRÓPRIO desde já: o
-- domínio nunca faz join com `iam.*` (só consome via função SQL ou via API), e o
-- futuro `permission-service` leva o schema inteiro (ADR-005/D4: "schema iam").
--
-- O QUE FAZ (idempotente, re-rodável — cada passo checa o catálogo antes):
--   1. CREATE SCHEMA iam.
--   2. Move as 8 tabelas da mig 206/268: tenants, permissions, permission_groups,
--      group_permissions, user_groups, user_departments, permission_audit_log,
--      group_country_scopes — com índices, constraints e sequências (SET SCHEMA leva tudo).
--   3. Views de compatibilidade `public.<nome>` (SELECT-only) para qualquer leitor
--      antigo não quebrar durante a transição — o e2e da 1.9 prova que NENHUM SQL do
--      repo depende delas (o grep de 16/08 achou só countryScopeGuard + a policy 271,
--      ambos re-apontados aqui/na 1.7).
--   4. Recria a policy `patients_country_isolation` da 271 apontando `iam.user_groups`
--      / `iam.group_country_scopes` — MESMOS 3 ramos, comportamento IDÊNTICO ao de hoje
--      (o ramo do claim só cai na 278). Sem isto a policy quebraria entre a 274 e a 278.
--   5. Reproduz no schema `iam` os privilégios da 269: default privileges para
--      app_runtime/app_system, USAGE no schema, e o REVOKE least-privilege sobre as
--      tabelas que DECIDEM o isolamento (a role confinada não forja o próprio grant —
--      lex C4: escrita só por SECURITY DEFINER, mig 279).
--
-- O QUE NÃO FAZ: não muda `search_path` do app (segue `public`); não toca `users`
-- (fica em public — é entidade de domínio compartilhada; `iam.*` referencia
-- `public.users(firebase_uid)` por FK como antes).
--
-- ROLLBACK: `ALTER TABLE iam.<t> SET SCHEMA public` nas 8 + DROP das views + recriar a
-- policy da 271 — testado no e2e (1.9) como caminho de reversão.

CREATE SCHEMA IF NOT EXISTS iam;
COMMENT ON SCHEMA iam IS
  'Identidade e permissões (grupos, catálogo, escopos de país, auditoria de decisão). '
  'Extraível para o permission-service (D115). Domínio NÃO faz join aqui: consome via '
  'iam.effective_*() ou via API.';

-- ── 2. Mover as tabelas (idempotente: só se ainda estiverem em public) ─────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants',
    'permissions',
    'permission_groups',
    'group_permissions',
    'user_groups',
    'user_departments',
    'permission_audit_log',
    'group_country_scopes'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA iam', t);
    END IF;
  END LOOP;
END
$$;

-- ── 3. Views de compatibilidade (leitura) ──────────────────────────────────────────
-- Só criadas quando a tabela JÁ está em iam e não existe tabela homônima em public.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants',
    'permissions',
    'permission_groups',
    'group_permissions',
    'user_groups',
    'user_departments',
    'permission_audit_log',
    'group_country_scopes'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'iam' AND c.relname = t AND c.relkind = 'r'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('CREATE VIEW public.%I AS SELECT * FROM iam.%I', t, t);
      EXECUTE format(
        'COMMENT ON VIEW public.%I IS %L',
        t,
        'Compatibilidade (mig 274): a tabela vive em iam.' || t ||
        '. Leitura só. Não escrever aqui; não usar em código novo.'
      );
    END IF;
  END LOOP;
END
$$;

-- ── 4. Policy da 271 re-apontada para iam.* (comportamento IDÊNTICO) ────────────────
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

-- ── 5. Privilégios no schema novo (espelho da 269) ─────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    GRANT USAGE ON SCHEMA iam TO app_runtime, app_system;

    -- Leitura nas 7 tabelas de controle/catálogo (o app lê grupos/catálogo/escopos).
    -- EXPLÍCITO, nunca "ALL TABLES IN SCHEMA iam": re-rodar esta migration depois da
    -- 280 re-abriria SELECT nas partições do audit log (achado no e2e, 16/08).
    GRANT SELECT ON iam.tenants, iam.permissions, iam.permission_groups,
      iam.group_permissions, iam.user_groups, iam.user_departments, iam.group_country_scopes
      TO app_runtime, app_system;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA iam TO app_runtime, app_system;

    -- Default para tabelas futuras do schema: como no public (269), SELECT/INSERT/
    -- UPDATE/DELETE — e cada tabela sensível REVOGA explicitamente na própria migration.
    ALTER DEFAULT PRIVILEGES IN SCHEMA iam
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA iam
      GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_system;

    -- Least-privilege sobre o próprio controle de acesso (269, agora em iam):
    -- role confinada não forja o próprio grant. Escrita = SECURITY DEFINER (279).
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON iam.permission_groups, iam.user_groups, iam.group_country_scopes,
         iam.group_permissions, iam.tenants, iam.permissions, iam.user_departments
      FROM app_runtime, app_system;

    -- Trilha de decisão: append-only. SELECT NÃO é concedido aqui — a 280 particiona
    -- e define INSERT-only mãe+partições; esta migration só garante INSERT e nega o resto.
    GRANT INSERT ON iam.permission_audit_log TO app_runtime, app_system;
    REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON iam.permission_audit_log FROM app_runtime, app_system;

    -- Views de compatibilidade: SELECT explícito nas 8 (NUNCA "ALL TABLES IN SCHEMA
    -- public" — a 270 revogou SELECT em resource_access_log de propósito).
    GRANT SELECT ON public.tenants, public.permissions, public.permission_groups,
      public.group_permissions, public.user_groups, public.user_departments,
      public.permission_audit_log, public.group_country_scopes
      TO app_runtime, app_system;
    -- ⚠️ E REVOGAR ESCRITA NAS VIEWS: view simples é AUTO-ATUALIZÁVEL e o Postgres
    -- checa INSERT/UPDATE/DELETE via view contra os privilégios do DONO DA VIEW (o
    -- owner das tabelas) — o default privilege da 269 em public daria INSERT na view
    -- às roles do app, e app_runtime FORJARIA o próprio grant passando pela view
    -- (pego pelo e2e do ABAC, cenário 9, em 16/08). Views de compat são SELECT-only.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.tenants, public.permissions, public.permission_groups,
         public.group_permissions, public.user_groups, public.user_departments,
         public.permission_audit_log, public.group_country_scopes
      FROM app_runtime, app_system;
  END IF;
END
$$;
