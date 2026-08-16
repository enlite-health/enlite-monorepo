-- 278: RLS de país GRANT-ONLY — o claim do IdP deixa de conceder acesso (D114/D115)
--
-- ⚠️⚠️ FORA DE migrations/ DE PROPÓSITO (scripts/rollout/): o runner NÃO aplica isto no
-- boot. Aplicação é MANUAL, gated, na task 5.4 do runbook, por ambiente:
--   psql "$DATABASE_URL" -f scripts/rollout/278_rls_country_grant_only.sql
-- Motivo (provado 16/08 na suíte e2e): na cadeia automática esta policy chegaria ao QA
-- — que está com COUNTRY_RLS_ENABLED=true — ANTES da migração de dados (5.1: todo
-- staff ACTIVE em grupo com o país dele) e o painel inteiro viraria "zero linhas"
-- (fail-closed correto, causa errada). Ordem obrigatória: 5.1 (dados) → 5.2/5.3
-- (engine + provas) → ESTA (5.4). Em prod, idem. Não há linha em schema_migrations
-- para ela; o estado é observável em pg_policy (COMMENT ON POLICY abaixo).
-- Enquanto o app conecta como owner (enlite_app, flag off), a policy é inerte — igual
-- à 271: ENABLE sem FORCE.
--
-- O QUE MUDA em relação à 274/271 (mesma tabela `patients`; satélites e
-- vacancy_relink_audit seguem por EXISTS e NÃO precisam mudar):
--   ANTES: sistema | country = claim (app.user_country) | grant vivo via user_groups
--   AGORA: sistema | country = ANY(iam.effective_countries(app.user_uid, tenant))
--
-- Por que resolver o grant DENTRO do banco (lex C3): a role confinada (`app_runtime`)
-- NUNCA afirma os próprios países. Se a policy lesse um GUC array vindo do app
-- (`app.user_countries`), uma injeção no caminho de staff faria
-- `SET app.user_countries='{AR,BR}'` e a RLS abriria o outro país — o furo que a
-- review da 269 fechou ("role confinada não forja o próprio grant"). O array no ALS
-- serve só ao guard de UX e ao resource_access_log; a verdade é iam.*.
-- Também elimina a janela de cache (≤30s) da RLS: revogação vale na query seguinte.
--
-- A função é STABLE e SECURITY INVOKER: por linha o planner a avalia uma vez por
-- statement (mesmo uid), e ela só lê iam.* + users (SELECT já concedido às roles).
-- Medição de p95 vs baseline-1.4 é gate da 5.4 (fallback sargável no design ABAC).
--
-- REVERSÃO: scripts/rollback/278_down.sql (recria a policy da 274, com o ramo do
-- claim) — testada no e2e (1.9). Executar reversão em prod = evento de segurança
-- (lex C5 do ABAC): registrar quem/quando/por quê.

DROP POLICY IF EXISTS patients_country_isolation ON patients;
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR country = ANY (
      iam.effective_countries(
        current_setting('app.user_uid', true),
        iam.current_tenant_id()
      )
    )
  );

COMMENT ON POLICY patients_country_isolation ON patients IS
  'Grant-only (mig 278): staff vê só os países dos seus grupos VIVOS, resolvidos NO banco '
  '(iam.effective_countries). O claim country do IdP é atributo, não permissão. Sistema '
  'declarado (app.system_context + membro de app_system) vê tudo. Sem GUC → zero linhas.';
