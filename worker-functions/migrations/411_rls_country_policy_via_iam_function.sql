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
--   ⚠️ LIMITE (medido no gate de 04/09): a policy é avaliada POR LINHA. A recusa em voz alta só
--   acontece quando a query alcança ao menos uma linha de `patients` — `WHERE id = '<inexistente>'`
--   segue devolvendo 0 linhas em silêncio. O que a 411 garante é: NENHUMA linha sai para sessão sem
--   identidade, e toda leitura que TOCA dado real falha nomeada. Não é "toda query sem identidade falha".
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
--   3. O ramo 1 (sistema) fica INLINE na policy, como na 274. Os ramos 2 (claim de país) e 3
--      (grant) vão para a função, que recebe `current_user` DA POLICY como argumento — dentro de
--      SECDEF `current_user` seria a DONA, não o chamador (armadilha provada no gate do #223) — e
--      só os honra para roles do app (`app_runtime`/`app_system`). Achado do lex em 04/09: o ramo
--      2 da 274 não tinha gate de role, e qualquer role de SQL livre (o conector do CEO) podia
--      declarar o próprio país com `set_config` — antes da 411 ela era fail-closed POR ACIDENTE
--      (`permission denied for schema iam`); sem o gate, a 411 a deixaria pior que antes.
--      Role fora do app → erro 42501 nomeado (`rls_role_without_session_identity`).
--      Comportamento para as roles do app: IDÊNTICO ao da 274 (mais as restrições abaixo).
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
--   o ramo passa a ser `iam.effective_countries` (276, INALTERADA) — vínculo removido, grupo arquivado e
--   tenant contam; na 274, vínculo removido e grupo arquivado ainda davam visão. E o "ativo" passa a
--   ser `users.status = 'ACTIVE'`, como nas funções efetivas e no painel — a 274 olhava `is_active`,
--   coluna DERIVADA e deprecated desde a 206 (trigger `trg_sync_user_status_to_is_active`; nenhum
--   código do app a escreve isolada, medido no gate). Precheck da 278, painel e policy respondem pela
--   mesma função. Nenhuma função existente é redefinida: apertar `effective_permissions` aqui (exigir as
--   duas flags) fecharia células de quem tivesse as flags divergentes, no boot, sem contagem — o gate
--   de 04/09 barrou essa versão.
--
-- RESÍDUO CONHECIDO (medido no gate): `p_role` vem de `current_user` na policy e não é forjável por
-- esse caminho; chamada DIRETA da função por role de fora morre antes, em USAGE do schema `iam`. Uma
-- role futura COM USAGE em `iam` e fora do app poderia chamar a função à mão e obter um booleano
-- "uid X tem país Y" (não uma linha). Revogar EXECUTE de PUBLIC não serve: a policy então falha com
-- `permission denied for function` em vez do erro nomeado (medido). Se essa role um dia existir, o
-- conserto é a policy passar `session_user`, não `current_user`.
--
-- FONTE ÚNICA: a policy é (re)criada em TRÊS lugares — aqui, `scripts/rollout/278_rls_country_grant_only.sql`
-- (flip grant-only, F14) e `scripts/rollback/278_down.sql`. Os três passam a usar ESTA função;
-- o que muda entre eles é só `p_honor_claim` (278 = false: grant-only). Foi assim que a suíte e2e
-- inteira reinstalou a policy velha por cima da 411 (o rollback da 278 tinha o texto da 274).
--
-- ROLLBACK: reaplicar o bloco "4. Policy da 271 re-apontada" da 274 (a policy volta a olhar `is_active`
-- e a ignorar vínculo removido/grupo arquivado — é o comportamento antigo, não um bug novo) e `DROP
-- FUNCTION iam.session_may_see_country(text, name, boolean)`. Nenhuma outra função foi alterada por
-- esta migration; nenhum dado é tocado. Em produção o rollback é evento de segurança (lex C5).
--
-- PROVA: `tests/e2e/country-rls-policies.test.ts` (testes 4 e 5c passam a esperar o erro nomeado) e
-- `tests/e2e/rls-policy-session-identity.e2e.test.ts` (role do app SEM privilégio em iam: erro nomeado
-- sem identidade, nunca vazio; com uid em grupo com escopo, VÊ — controle positivo; role FORA do app
-- que declara o próprio país/uid por set_config: erro nomeado, nunca uma linha).

-- A policy sai ANTES da função (ela depende da função); é recriada no fim, apontando para a nova.
-- A assinatura de 1 argumento é de um rascunho desta migration: não existe em stage/prod, mas
-- CREATE OR REPLACE com outra assinatura criaria uma sobrecarga — apaga se houver.
DROP POLICY IF EXISTS patients_country_isolation ON patients;
DROP FUNCTION IF EXISTS iam.session_may_see_country(TEXT);

CREATE OR REPLACE FUNCTION iam.session_may_see_country(p_country TEXT, p_role NAME, p_honor_claim BOOLEAN)
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
  -- Gate por ROLE, recebido da policy (`current_user` lá é o chamador; aqui dentro seria a dona).
  -- Só as roles do app carregam identidade de sessão VERIFICADA (o middleware seta as GUCs a
  -- partir do token). Qualquer outra role — mcp_ro, psql, uma role futura — pode rodar
  -- `SELECT set_config('app.user_country', 'BR', true)` e declarar o próprio país: para ela a
  -- GUC não é identidade, é auto-declaração. Recusa em voz alta, nunca "vazio" nem "confiar".
  IF NOT (pg_has_role(p_role, 'app_runtime', 'MEMBER') OR pg_has_role(p_role, 'app_system', 'MEMBER')) THEN
    RAISE EXCEPTION 'rls_role_without_session_identity: a role % não carrega identidade de sessão verificada (não é app_runtime nem app_system) — a policy de país de patients não decide para ela', p_role
      USING ERRCODE = '42501';
  END IF;

  IF v_uid IS NULL AND v_country IS NULL AND v_system IS NULL THEN
    -- Sessão sem identidade: NÃO é "zero pacientes", é "ninguém está perguntando".
    -- Mensagem sem dado pessoal; código 42501 (insufficient_privilege) — a mesma classe que
    -- o app já mapeia para "sem permissão".
    RAISE EXCEPTION 'rls_session_without_identity: a sessão não carrega app.user_uid, app.user_country nem app.system_context — a policy de país de patients não decide sem identidade'
      USING ERRCODE = '42501';
  END IF;

  -- Ramo 2 (claim de país do IdP). A 278 (grant-only, F14) chama com p_honor_claim = false.
  IF p_honor_claim AND v_country IS NOT NULL AND v_country = p_country THEN
    RETURN TRUE;
  END IF;

  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Ramo 3: grant de país pelos grupos VIVOS — a MESMA função que o precheck da 278 e o painel
  -- usam (`iam.effective_countries`, 276, inalterada). Fonte única do predicado: policy, precheck e
  -- tela não podem discordar sobre quem vê o quê.
  RETURN p_country = ANY (iam.effective_countries(v_uid, iam.current_tenant_id()));
END;
$$;

COMMENT ON FUNCTION iam.session_may_see_country(TEXT, NAME, BOOLEAN) IS
  '411: ramos 2 (claim, se p_honor_claim) e 3 (uid em grupo com escopo) da policy de país de patients, avaliados com o privilégio da dona de iam.*; recusa 42501 nomeada para role fora do app e para sessão sem identidade.';

-- EXECUTE a PUBLIC é o default de função nova; explícito porque é DECISÃO: toda role que a
-- policy avalie precisa poder chamá-la — e é a própria função que recusa as que não são do app.
-- Chamada direta por outra role devolve só boolean (ou o erro); não expõe linha nenhuma.
GRANT EXECUTE ON FUNCTION iam.session_may_see_country(TEXT, NAME, BOOLEAN) TO PUBLIC;

-- ── Policy: ramo 1 (sistema) inline como na 274; ramos 2 e 3 pela função, com o gate de role ─
DROP POLICY IF EXISTS patients_country_isolation ON patients;
CREATE POLICY patients_country_isolation ON patients
  FOR ALL
  USING (
    (
      NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
      AND pg_has_role(current_user, 'app_system', 'MEMBER')
    )
    OR iam.session_may_see_country(patients.country, current_user, true)
  );
