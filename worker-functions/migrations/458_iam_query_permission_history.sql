-- 458: histórico de mudanças de permissão — LEITURA gated, molde de iam.query_audit (mig 279)
--
-- POR QUÊ: a tela "Auditoría de decisiones" (`/admin/access/audit`) responde ALLOW/DENY de
-- autorização — não responde "quem mudou uma permissão, em qual grupo, quando, e qual foi a
-- mudança". Essa pergunta já tem fonte: `iam.permission_group_changes` (escrita em
-- `iam.set_group_permissions`, mig 279) e `iam.user_groups` (uma linha pode virar até DOIS
-- eventos — entrou e, se `removed_at` não for nulo, saiu). Esta função UNE as duas fontes numa
-- lista só, ordenada por data, já resolvendo nome de grupo e de pessoa (join com `public.users`
-- e `iam.permission_groups`, dentro da própria função — a role do app não precisa de SELECT a
-- mais para isso). O rótulo da CÉLULA (resource:action) o front resolve com o MESMO i18n que a
-- tela do grupo já usa — texto traduzido não é papel do banco.
--
-- Gate: idêntico ao de `iam.query_audit` — GUC do ator (`iam._actor()`) + `permission_management:
-- read` vigente via `iam.effective_permissions`. Gate por GUC pode ficar DENTRO da SECURITY
-- DEFINER (current_setting é da sessão do chamador); um gate por ROLE aqui seria inútil, porque
-- dentro da função `current_user` é o DONO, não quem chamou (lex, mig 279 comentário). Por isso
-- o ACL (REVOKE FROM PUBLIC + GRANT só a app_runtime/app_system) é reforço, não o gate em si.
--
-- `reason` de `permission_group_changes` NUNCA é selecionado — é texto livre, pode conter
-- qualquer coisa, e a spec da tela nova proíbe expor esse campo.

CREATE OR REPLACE FUNCTION iam.query_permission_history(p_group_id UUID, p_type VARCHAR, p_limit INT)
RETURNS TABLE (
  event_type VARCHAR,
  occurred_at TIMESTAMPTZ,
  group_id UUID,
  group_name TEXT,
  actor_uid VARCHAR,
  actor_display_name TEXT,
  actor_email TEXT,
  op VARCHAR,
  resource VARCHAR,
  action VARCHAR,
  subject_user_id VARCHAR,
  subject_display_name TEXT,
  subject_email TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor  VARCHAR := iam._actor();
  v_tenant UUID    := iam.current_tenant_id();
BEGIN
  IF v_actor IS NULL OR NOT ('permission_management:read' = ANY (iam.effective_permissions(v_actor, v_tenant))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] permission_management:read ausente';
  END IF;

  -- Grupo de outro tenant (ou inexistente): lista vazia, não erro — mesma indistinguibilidade
  -- que `PanelGroupReader.findById` já pratica na API do painel (404 sem confirmar existência).
  IF p_group_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = p_group_id AND g.tenant_id = v_tenant) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ev.event_type, ev.occurred_at, ev.group_id, ev.group_name,
         ev.actor_uid, ev.actor_display_name, ev.actor_email,
         ev.op, ev.resource, ev.action,
         ev.subject_user_id, ev.subject_display_name, ev.subject_email
  FROM (
    -- ── Permissão adicionada/removida do grupo (iam.set_group_permissions) ──────────
    -- ⚠️ Casts explícitos p/ TEXT: `permission_groups.name`, `users.display_name`
    -- e `users.email` são `varchar(255)` no schema — Postgres exige o tipo da
    -- coluna do SELECT bater EXATAMENTE com o declarado em RETURNS TABLE (sem
    -- cast implícito varchar→text), senão `RETURN QUERY` levanta 42804
    -- ("structure of query does not match function result type"). Medido
    -- 22/09/2026 contra Postgres real — a suíte local (que não sobe Postgres)
    -- não pega isso; só a corrida contra o banco discrimina.
    SELECT
      'permission'::varchar   AS event_type,
      pgc.changed_at          AS occurred_at,
      pgc.group_id,
      g.name::text             AS group_name,
      pgc.changed_by          AS actor_uid,
      ua.display_name::text    AS actor_display_name,
      ua.email::text           AS actor_email,
      pgc.op::varchar         AS op,
      p.resource,
      p.action,
      NULL::varchar           AS subject_user_id,
      NULL::text              AS subject_display_name,
      NULL::text              AS subject_email
    FROM iam.permission_group_changes pgc
    JOIN iam.permission_groups g ON g.id = pgc.group_id AND g.tenant_id = v_tenant
    LEFT JOIN iam.permissions p ON p.id = pgc.permission_id
    LEFT JOIN users ua ON ua.firebase_uid = pgc.changed_by
    WHERE p_group_id IS NULL OR pgc.group_id = p_group_id

    UNION ALL

    -- ── Membro adicionado ao grupo (sempre existe: toda linha tem assigned_at) ──────
    SELECT
      'member'::varchar,
      ug.assigned_at,
      ug.group_id,
      g.name::text,
      ug.assigned_by,
      uaa.display_name::text,
      uaa.email::text,
      'add'::varchar,
      NULL::varchar,
      NULL::varchar,
      ug.user_id,
      us1.display_name::text,
      us1.email::text
    FROM iam.user_groups ug
    JOIN iam.permission_groups g ON g.id = ug.group_id AND g.tenant_id = v_tenant
    LEFT JOIN users uaa ON uaa.firebase_uid = ug.assigned_by
    LEFT JOIN users us1 ON us1.firebase_uid = ug.user_id
    WHERE p_group_id IS NULL OR ug.group_id = p_group_id

    UNION ALL

    -- ── Membro removido do grupo (só quando removed_at não é nulo — a MESMA linha
    --    de `user_groups` já contou como "add" acima; aqui ela conta de novo como "remove") ──
    SELECT
      'member'::varchar,
      ug.removed_at,
      ug.group_id,
      g.name::text,
      ug.removed_by,
      uar.display_name::text,
      uar.email::text,
      'remove'::varchar,
      NULL::varchar,
      NULL::varchar,
      ug.user_id,
      us2.display_name::text,
      us2.email::text
    FROM iam.user_groups ug
    JOIN iam.permission_groups g ON g.id = ug.group_id AND g.tenant_id = v_tenant
    LEFT JOIN users uar ON uar.firebase_uid = ug.removed_by
    LEFT JOIN users us2 ON us2.firebase_uid = ug.user_id
    WHERE ug.removed_at IS NOT NULL
      AND (p_group_id IS NULL OR ug.group_id = p_group_id)
  ) ev
  WHERE p_type IS NULL OR ev.event_type = p_type
  ORDER BY ev.occurred_at DESC
  LIMIT LEAST(COALESCE(p_limit, 200), 1000);
END;
$$;

REVOKE ALL ON FUNCTION iam.query_permission_history(uuid, varchar, int) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.query_permission_history(uuid, varchar, int) TO app_runtime, app_system;
  END IF;
END
$$;
