-- 411: a policy de país de `patients` consulta o IAM por função SECURITY DEFINER — e recusa
--      EM VOZ ALTA a sessão sem identidade nenhuma (faixa 410-419 = trem ABAC, ver 410)
--
-- POR QUÊ (medido 30/08 e 04/09/2026 na stage, e2e `mcp-ro-role` do main):
--   O 3º ramo da policy da 274 (`EXISTS ... FROM iam.user_groups ... iam.group_country_scopes`)
--   roda com os privilégios de QUEM CONSULTA. Uma role sem USAGE em `iam` — hoje `enlite_mcp_ro`,
--   o conector claude.ai do CEO; amanhã qualquer role nova — não recebe "0 linhas": recebe
--   `permission denied for schema iam` em TODA leitura de `patients`, inclusive nas colunas que a
--   role tem GRANT. E consertar com `GRANT SELECT ON iam.* TO <role>` é dar a uma role de leitura
--   externa a lista de quem está em qual grupo. Consertar a instância (grant à mcp_ro) não conserta
--   a classe; a classe é "a policy depende do privilégio do chamador".
--
--   Segundo problema, pior porque é silencioso: sessão SEM contexto nenhum (sem `app.system_context`,
--   sem `app.user_uid`, sem `app.user_country`) caía nos três ramos falsos e recebia conjunto VAZIO.
--   Para um humano lendo por ferramenta, "não há pacientes" e "você não tem identidade nesta sessão"
--   são indistinguíveis — e ele decide acreditando no vazio. Contagem zero é falha, nunca sucesso.
--
-- O QUE MUDA:
--   1. `iam.session_may_see_country(p_country)` — SECURITY DEFINER, dona = dona de `iam.*` (a mesma
--      que roda as migrations), `search_path` fixo. Lê a GUC `app.user_uid` da SESSÃO DO CHAMADOR
--      (GUC sobrevive à troca de contexto da SECDEF) e responde o 3º ramo sem exigir privilégio em
--      `iam` de quem consulta. EXECUTE a PUBLIC: qualquer role que a policy avalie precisa chamá-la;
--      ela só lê, e devolve boolean.
--   2. A MESMA função levanta `42501` quando a sessão não tem identidade nenhuma. Fica nela (e não
--      no app) porque a policy é o único lugar que TODA leitura de `patients` atravessa, seja qual for
--      o caminho — pool, MCP, psql. Sessão com identidade parcial (só país, só uid) NÃO levanta: o
--      ramo correspondente decide, como antes.
--   3. Os ramos 1 (sistema) e 2 (país da sessão) ficam INLINE na policy, como na 274: o ramo 1 usa
--      `pg_has_role(current_user, ...)`, e dentro de SECDEF `current_user` seria a DONA, não o
--      chamador (armadilha provada no gate do #223). Comportamento dos ramos 1 e 2: IDÊNTICO.
--
-- O QUE NÃO MUDA (de propósito):
--   • Quem atravessa a fronteira de país continua sendo decidido pelos grupos (`group_country_scopes`)
--     — esta migration NÃO dá a nenhuma role passagem por nome. Se o conector do CEO deve ver os dois
--     países, isso é decisão do jurídico + Gabriel/Marcel (C10 do lex, D216/D218), com prazo antes de
--     ligar o engine em QA (F13) — e o mecanismo previsto é dar IDENTIDADE ao principal, não bypass.
--   • Satélites (`*_follow_patient`, 271) seguem o pai por `EXISTS (SELECT 1 FROM patients ...)`,
--     logo herdam a recusa em voz alta sem tocar em nada.
--   • Dona de `patients` (`enlite_app`) não passa por policy (sem FORCE) — inalterado.
--
-- DIFERENÇAS DELIBERADAS no 3º ramo (a 274 nasceu antes da 275/276 e nunca foi atualizada):
--   `ug.removed_at IS NULL` (vínculo removido seguia dando visão), `g.archived_at IS NULL` (grupo
--   arquivado idem), `g.tenant_id` e `u.status = 'ACTIVE'` além de `u.is_active` — `users` tem
--   DUAS flags de ativo e a policy exige as duas. É o predicado da 276 + o da 274, o mais estrito.
--
-- FONTE ÚNICA: a policy é (re)criada em TRÊS lugares — aqui, `scripts/rollout/278_rls_country_grant_only.sql`
-- (flip grant-only, F14) e `scripts/rollback/278_down.sql`. Os três passam a usar ESTA função
-- no ramo de grant; o que muda entre eles é só a presença do ramo 2 (claim de país). Foi assim que
-- a suíte e2e inteira reinstalou a policy velha por cima da 411 (o rollback da 278 tinha o texto da 274).
--
-- ROLLBACK: reaplicar o bloco "4. Policy da 271 re-apontada" da 274 e `DROP FUNCTION
-- iam.session_may_see_country(text)`. Sem dado envolvido.
--
-- PROVA: `tests/e2e/country-rls-policies.test.ts` (testes 4 e 5c passam a esperar o erro nomeado) e
-- `tests/e2e/rls-policy-session-identity.e2e.test.ts` (role SEM grant em iam: erro nomeado, nunca
-- `permission denied for schema iam`, nunca vazio; com uid em grupo com escopo, VÊ — controle positivo).

CREATE OR REPLACE FUNCTION iam.session_may_see_country(p_country TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_uid     TEXT := NULLIF(current_setting('app.user_uid', true), '');
  v_country TEXT := NULLIF(current_setting('app.user_country', true), '');
  v_system  TEXT := NULLIF(current_setting('app.system_context', true), '');
BEGIN
  IF v_uid IS NULL AND v_country IS NULL AND v_system IS NULL THEN
    -- Sessão sem identidade: NÃO é "zero pacientes", é "ninguém está perguntando".
    -- Mensagem sem dado pessoal; código 42501 (insufficient_privilege) — a mesma classe que
    -- o app já mapeia para "sem permissão".
    RAISE EXCEPTION 'rls_session_without_identity: a sessão não carrega app.user_uid, app.user_country nem app.system_context — a policy de país de patients não decide sem identidade'
      USING ERRCODE = '42501';
  END IF;

  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  -- O predicado mais ESTRITO entre a 274 (is_active) e a 276 (status, grupo não arquivado,
  -- tenant): `users` tem duas flags de "ativo" e a policy exige as duas — fail-closed.
  RETURN EXISTS (
    SELECT 1
    FROM iam.user_groups ug
    JOIN public.users u
      ON u.firebase_uid = ug.user_id
     AND u.is_active IS TRUE
     AND u.status = 'ACTIVE'
    JOIN iam.permission_groups g
      ON g.id = ug.group_id
     AND g.tenant_id = iam.current_tenant_id()
     AND g.archived_at IS NULL
    JOIN iam.group_country_scopes gcs
      ON gcs.group_id = g.id
     AND gcs.revoked_at IS NULL
    WHERE ug.user_id = v_uid
      AND ug.removed_at IS NULL
      AND gcs.country = p_country
  );
END;
$$;

COMMENT ON FUNCTION iam.session_may_see_country(TEXT) IS
  '411: 3º ramo da policy de país de patients (uid em grupo com escopo), avaliado com o privilégio da dona de iam.* — e recusa 42501 quando a sessão não tem identidade nenhuma.';

-- EXECUTE a PUBLIC é o default de função nova; explícito porque é DECISÃO: toda role que a
-- policy avalie (app_runtime, app_system, enlite_mcp_ro, ...) precisa poder chamá-la.
GRANT EXECUTE ON FUNCTION iam.session_may_see_country(TEXT) TO PUBLIC;

-- ── Policy: ramos 1 e 2 inline (idênticos à 274), ramo 3 pela função ─────────────────
DROP POLICY IF EXISTS patients_country_isolation ON patients;
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR country = current_setting('app.user_country', true)
    OR iam.session_may_see_country(patients.country)
  );
