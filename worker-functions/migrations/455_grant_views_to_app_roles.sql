-- 455: GRANT SELECT nas views/pais-de-partição esquecidos pelo laço da 269 + security_invoker
-- (Fase E, isolamento por país — Bloco 5.4)
--
-- ACHADO DE CLASSE (medido 20/09/2026 contra prd): o laço de GRANT da 269_app_runtime_roles.sql
-- (linhas 44-57) filtra `n.nspname = 'public'` e `c.relkind IN ('r','p','S')` — nunca concedeu
-- SELECT a app_runtime/app_system em VIEW nenhuma, e nunca alcançou o schema `iam` (que só nasceu
-- na 274, depois da 269 já ter rodado). Resultado medido: 11 objetos sem SELECT para as roles de
-- runtime — 9 views de `public` (prova positiva do instrumento: as outras 9 views dos mesmos
-- schemas já tinham SELECT) + os PAIS de partição de `public.resource_access_log` e
-- `iam.permission_audit_log`. Nenhuma das 18 views tinha `security_invoker` (`reloptions` vazio).
-- (`v_patient_source_inventory`, criada pela 439 DEPOIS da 269 já ter fixado o default privilege,
-- pode aparecer já com SELECT num ambiente onde a 439 rodou como o mesmo role que criou o default
-- — medido localmente. GRANT é idempotente e cobre os dois casos sem checar antes.)
--
-- 🔴 DECISÃO DO GABRIEL, 20/09/2026 — leia antes de re-litigar: 3 dos 11 NÃO são omissão do laço,
-- são REVOKE DELIBERADO de migrations posteriores, e o Gabriel decidiu conceder SELECT mesmo
-- assim, CIENTE da troca:
--   • public.resource_access_log  (pai de partição) — REVOKE ALL + GRANT INSERT em 270:69-70
--     ("Append-only de verdade" / "leitura só pelo owner", comentário 270:17 e 270:66).
--   • iam.permission_audit_log    (pai de partição) — mesmo padrão em 274:155 e 280:114-115.
--   • public.permission_audit_log (view de compat)  — REVOKE ALL em 280:116.
-- Esta migration SOBREPÕE o least-privilege dessas três migrations por decisão explícita do
-- Gabriel (20/09/2026) — não é reversão automática de bug nem "conserto de mais um achado": a
-- trilha de auditoria passa a ser LEGÍVEL para as roles de runtime. Comando de rollback no rodapé.
--
-- O QUE FAZ (idempotente — GRANT/ALTER VIEW SET/COMMENT ON não erram em re-run):
--   a) GRANT SELECT explícito nos 11 objetos nomeados acima — documenta a intenção linha a linha.
--   b) Laço de catch-up — o CONSERTO DE CLASSE: todo view/matview de `public` E `iam` cujo dono a
--      role desta migration integre (`pg_has_role(current_user, c.relowner, 'MEMBER')`, MESMO
--      guard da 269:50) recebe SELECT. NUNCA um `GRANT ... ON ALL TABLES` cru: abortaria a
--      migration inteira se UMA relação tivesse outro dono (ex.: views do PostGIS —
--      `geography_columns`/`geometry_columns` — não pertencem à role das migrations em todo
--      ambiente). Redundante com (a) para as 9 views — mantido de propósito: (a) documenta a
--      intenção nomeada, (b) pega qualquer view/matview esquecida que ninguém nomeou aqui.
--   c) `security_invoker = true` nas 9 VIEWS (não nos pais de partição — não são view). Por quê:
--      view do dono sem `security_invoker` roda com o privilégio do DONO e IGNORA a RLS das
--      tabelas de baixo — 6 das 9 leem `workers`, que ganha policy de país no Bloco 6 desta fase.
--      HOJE é no-op (o app conecta como `enlite_app`, o dono das views); DEPOIS do Bloco 6 seria
--      exatamente o furo que a Fase E existe para fechar.
--      ⚠️ `public.permission_audit_log` é view de compat sobre `iam.permission_audit_log`. Com
--      `security_invoker=true` ela passa a exigir privilégio do INVOCADOR na tabela de baixo —
--      que o item (a), executado ANTES de (c) na mesma transação, já concedeu. Sem essa ordem
--      haveria janela em que a view perderia leitura para o próprio app_runtime; com ela, não há
--      janela incoerente (tudo comita junto).
--
-- PG do ambiente de teste: 16.4 (`server_version_num` 160004) — `security_invoker` exige PG 15+.
--
-- ROLLBACK (nunca DROP):
--   BEGIN;
--   ALTER VIEW public.users_active                  SET (security_invoker = false);
--   ALTER VIEW public.v_patient_source_inventory     SET (security_invoker = false);
--   ALTER VIEW public.v_potential_duplicate_workers  SET (security_invoker = false);
--   ALTER VIEW public.v_worker_registration_overview SET (security_invoker = false);
--   ALTER VIEW public.v_workers_current_employment   SET (security_invoker = false);
--   ALTER VIEW public.workers_docs_expiry_alert      SET (security_invoker = false);
--   ALTER VIEW public.workers_profession_divergence  SET (security_invoker = false);
--   ALTER VIEW public.workers_without_users          SET (security_invoker = false);
--   ALTER VIEW public.permission_audit_log           SET (security_invoker = false);
--   REVOKE SELECT ON
--     public.users_active, public.v_patient_source_inventory,
--     public.v_potential_duplicate_workers, public.v_worker_registration_overview,
--     public.v_workers_current_employment, public.workers_docs_expiry_alert,
--     public.workers_profession_divergence, public.workers_without_users,
--     public.permission_audit_log, public.resource_access_log, iam.permission_audit_log
--     FROM app_runtime, app_system;
--   COMMIT;
--   -- ⚠️ o laço de catch-up (b) pode ter concedido SELECT a OUTRA view/matview esquecida além
--   -- das 9 nomeadas — se o rollback precisar desfazer TUDO que esta migration tocou, repetir o
--   -- mesmo laço trocando GRANT por REVOKE (mesmo filtro de dono) contra o estado anterior a esta.

BEGIN;

DO $$
DECLARE
  rel RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    RAISE NOTICE '[455] app_runtime/app_system ausentes — nada a conceder (a 269 roda antes desta na ordem numérica; ambiente incompleto)';
    RETURN;
  END IF;

  -- ── (a) explícito — os 11 objetos nomeados no achado de 20/09/2026 ────────────────
  EXECUTE $g$GRANT SELECT ON
    public.users_active,
    public.v_patient_source_inventory,
    public.v_potential_duplicate_workers,
    public.v_worker_registration_overview,
    public.v_workers_current_employment,
    public.workers_docs_expiry_alert,
    public.workers_profession_divergence,
    public.workers_without_users,
    public.permission_audit_log,
    public.resource_access_log,
    iam.permission_audit_log
    TO app_runtime, app_system$g$;

  -- ── (b) laço de catch-up — o conserto de CLASSE ───────────────────────────────────
  FOR rel IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'iam')
      AND c.relkind IN ('v', 'm')
      AND pg_has_role(current_user, c.relowner, 'MEMBER')
  LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO app_runtime, app_system', rel.nspname, rel.relname);
  END LOOP;

  -- ── (c) security_invoker = true — só nas 9 VIEWS (pai de partição não é view) ─────
  EXECUTE 'ALTER VIEW public.users_active                  SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_patient_source_inventory     SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_potential_duplicate_workers  SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_worker_registration_overview SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.v_workers_current_employment   SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.workers_docs_expiry_alert      SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.workers_profession_divergence  SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.workers_without_users          SET (security_invoker = true)';
  EXECUTE 'ALTER VIEW public.permission_audit_log           SET (security_invoker = true)';
END
$$;

COMMENT ON VIEW public.permission_audit_log IS
  'Compatibilidade (mig 274/280): tabela em iam.permission_audit_log (particionada). SELECT '
  'concedido a app_runtime/app_system por decisão do Gabriel (20/09/2026, mig 455) — sobrepõe '
  'o least-privilege da 280. Leitura auditada e gated continua via iam.query_audit.';
COMMENT ON TABLE public.resource_access_log IS
  'Trilha de leitura de recurso sensível (quem ABRIU o quê). Append-only; SELECT concedido a '
  'app_runtime/app_system por decisão do Gabriel (20/09/2026, mig 455) — sobrepõe o least-'
  'privilege da 270 (lex C2 revisitado).';
COMMENT ON TABLE iam.permission_audit_log IS
  'Trilha de DECISÃO de permissão (DENY sempre; ALLOW em PII/paciente/documento/delete/export — '
  'D-P4). Append-only; SELECT concedido a app_runtime/app_system por decisão do Gabriel '
  '(20/09/2026, mig 455) — sobrepõe o least-privilege da 274/280.';

COMMIT;
