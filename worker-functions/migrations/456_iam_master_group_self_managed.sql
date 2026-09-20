-- 456 — Bloco 2 da spec 021: "só o Acesso Master altera o Acesso Master"
--
-- POR QUÊ: `iam._require_manager()` (mig 279) só checa a célula
-- `permission_management:write` — não checa DE QUAL grupo ela veio. Medido em
-- prd hoje (20/09/2026): 2 grupos têm essa célula (Acesso Master e Super
-- Admin), e o Super Admin tem 1 membro vivo. Ou seja, hoje 1 pessoa DE FORA
-- do Acesso Master pode renomear, arquivar, trocar células, país ou membros
-- do Acesso Master — a célula abre a porta, mas não diz que a porta é a DELE.
--
-- O QUE FAZ: toda escrita cujo grupo-alvo é o Acesso Master (UUID fixo
-- a0000000-0000-0000-0000-000000000001 — mesmo id da 451/436) passa a exigir
-- que o ATOR seja membro VIVO do Acesso Master (`iam.user_groups.removed_at
-- IS NULL`), além de já ter `permission_management:write`. Vale SÓ para esse
-- UUID — nunca para `is_system` em geral (Super Admin e outros grupos de
-- sistema NÃO são tocados; D285/432 já tratam Super Admin à parte, fora do
-- escopo nomeado deste bloco).
--
-- PISO ANTI-LOCKOUT: o Acesso Master tem 5 membros vivos hoje (as contas
-- fixas da 451), e a 451 trava a REMOÇÃO dessas 5 contas do Master. Logo este
-- guard não tranca ninguém — as 5 contas fixas continuam podendo alterar o
-- próprio Master, e é exatamente essa a garantia que falta hoje.
--
-- CONTEXTO DE SISTEMA: `iam._is_system_context()` passa direto (mesmo padrão
-- de `iam.sync_country_feature_default`, 279) — nenhum caminho de boot/cron
-- hoje chama estas 7 funções em contexto de sistema (o sync do catálogo usa
-- `grant_active_permissions_to_master`/`grant_master_fixed_accounts`, funções
-- PRÓPRIAS da 436/451 que não passam por `_require_manager`), mas a checagem
-- fica pronta para não quebrar um caminho de sistema futuro.
--
-- MENSAGEM PRÓPRIA: ERRCODE 42501 (mesma classe de `_require_manager` — é
-- uma negação de autorização, não uma invariante de dado). O TEXTO é novo e
-- não repete nem "[iam] permission_management:write ausente para o ator"
-- (_require_manager, 279) nem contém a substring "conta fixa" (marca da 451)
-- — `PermissionError.ts` (toPermissionError) lê essas marcas para 23514; como
-- aqui o código é 42501, cai em 'forbidden' de qualquer forma (não há branch
-- por mensagem para 42501), mas a mensagem precisa ser DISTINGUÍVEL em log e
-- teste de qual checagem barrou.
--
-- DE QUAL MIGRATION CADA FUNÇÃO PARTIU (git grep "CREATE OR REPLACE FUNCTION
-- iam.<nome>" em origin/stage — migration de número mais alto por função):
--   update_group            ← 279_iam_writer_functions.sql (única definição)
--   archive_group           ← 279_iam_writer_functions.sql (única definição)
--   set_group_permissions   ← 279_iam_writer_functions.sql (única definição)
--   grant_country           ← 412_group_country_reason_opcional.sql (⚠️ NÃO 279 —
--                              a 412 removeu a exigência de p_reason; copiar o
--                              corpo da 279 aqui reverteria essa decisão em
--                              silêncio)
--   revoke_country          ← 279_iam_writer_functions.sql (única definição)
--   add_member              ← 279_iam_writer_functions.sql (única definição)
--   remove_member           ← 279_iam_writer_functions.sql (única definição)
-- Em cada uma, a ÚNICA mudança é uma linha `PERFORM
-- iam._require_master_membership(p_group_id);` logo após `v_actor :=
-- iam._require_manager(...)` — nenhuma outra linha do corpo original mudou.
--
-- Idempotente (CREATE OR REPLACE) e re-rodável.
--
-- ROLLBACK: reaplicar a definição de cada função exatamente como está em
-- 279_iam_writer_functions.sql (update_group, archive_group,
-- set_group_permissions, revoke_country, add_member, remove_member) e em
-- 412_group_country_reason_opcional.sql (grant_country), e depois
-- `DROP FUNCTION IF EXISTS iam._require_master_membership(uuid);`.

BEGIN;

-- ── Guard: só membro vivo do Acesso Master mexe no Acesso Master ─────────────
CREATE OR REPLACE FUNCTION iam._require_master_membership(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_actor VARCHAR;
  v_e_membro BOOLEAN;
BEGIN
  IF p_group_id IS DISTINCT FROM v_master_id THEN
    RETURN;   -- guard só existe para o Acesso Master — nunca para is_system em geral
  END IF;

  IF iam._is_system_context() THEN
    RETURN;   -- mesmo bypass de sync_country_feature_default (279) — não quebra boot/cron
  END IF;

  -- Chega aqui só depois de `_require_manager` já ter aprovado o ator, então
  -- `v_actor` nunca é NULL neste ponto (senão _require_manager já teria
  -- levantado 42501 antes).
  v_actor := iam._actor();

  SELECT EXISTS (
    SELECT 1 FROM iam.user_groups ug
     WHERE ug.user_id = v_actor AND ug.group_id = v_master_id AND ug.removed_at IS NULL
  ) INTO v_e_membro;

  IF NOT v_e_membro THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format(
        '[iam] ator %s tem permission_management:write mas não é membro vivo do Acesso Master — só quem pertence ao Acesso Master pode alterá-lo (spec 021, bloco 2, guard de pertencimento)',
        v_actor
      );
  END IF;
END;
$$;
COMMENT ON FUNCTION iam._require_master_membership(UUID) IS
  'Spec 021, bloco 2 (decisão do Gabriel, 20/09/2026): quando p_group_id é o Acesso Master '
  '(UUID fixo a0000000-0000-0000-0000-000000000001), exige que o ator seja membro VIVO dele — '
  'além da célula permission_management:write que _require_manager já checou. Não vale para '
  'nenhum outro grupo, nem para is_system em geral. Contexto de sistema passa direto.';

-- ── Grupos ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.update_group(p_group_id UUID, p_name TEXT, p_description TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  IF v_g.is_system AND p_name IS DISTINCT FROM v_g.name THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] grupo de sistema não pode ser renomeado';
  END IF;
  UPDATE iam.permission_groups
     SET name = COALESCE(p_name, name), description = p_description, updated_at = now()
   WHERE id = p_group_id;
END;
$$;

CREATE OR REPLACE FUNCTION iam.archive_group(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou já arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  IF v_g.is_system THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '[iam] grupo de sistema não pode ser arquivado';
  END IF;
  UPDATE iam.permission_groups SET archived_at = now(), archived_by = v_actor, updated_at = now()
   WHERE id = p_group_id;
  PERFORM iam._assert_not_last_manager(v_g.tenant_id);
END;
$$;

-- Composição: substitui o conjunto de células pelo informado; diff → permission_group_changes.
CREATE OR REPLACE FUNCTION iam.set_group_permissions(p_group_id UUID, p_permission_ids UUID[], p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_bad INT;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);

  -- toda célula precisa existir no catálogo e não estar descontinuada
  SELECT count(*) INTO v_bad
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  WHERE NOT EXISTS (SELECT 1 FROM iam.permissions p WHERE p.id = x.id AND p.deprecated_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = format('[iam] %s célula(s) fora do catálogo ou descontinuada(s)', v_bad);
  END IF;

  -- removidas
  INSERT INTO iam.permission_group_changes (group_id, permission_id, op, changed_by, reason)
  SELECT gp.group_id, gp.permission_id, 'remove', v_actor, p_reason
  FROM iam.group_permissions gp
  WHERE gp.group_id = p_group_id
    AND NOT (gp.permission_id = ANY (COALESCE(p_permission_ids, ARRAY[]::UUID[])));
  DELETE FROM iam.group_permissions gp
  WHERE gp.group_id = p_group_id
    AND NOT (gp.permission_id = ANY (COALESCE(p_permission_ids, ARRAY[]::UUID[])));

  -- adicionadas
  INSERT INTO iam.permission_group_changes (group_id, permission_id, op, changed_by, reason)
  SELECT p_group_id, x.id, 'add', v_actor, p_reason
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  WHERE NOT EXISTS (SELECT 1 FROM iam.group_permissions gp WHERE gp.group_id = p_group_id AND gp.permission_id = x.id);
  INSERT INTO iam.group_permissions (group_id, permission_id)
  SELECT p_group_id, x.id
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  ON CONFLICT DO NOTHING;

  PERFORM iam._assert_not_last_manager(v_g.tenant_id);
END;
$$;

-- ── País ──────────────────────────────────────────────────────────────────────
-- Corpo partido da 412 (NÃO da 279): a 412 tornou p_reason opcional — copiar a
-- 279 aqui reverteria essa decisão em silêncio.
CREATE OR REPLACE FUNCTION iam.grant_country(p_group_id UUID, p_country VARCHAR, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_id UUID;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  -- Sem exigência de motivo (mig 412) — motivo em branco vira NULL.
  SELECT id INTO v_id FROM iam.group_country_scopes
   WHERE group_id = p_group_id AND country = p_country AND revoked_at IS NULL;
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
  VALUES (p_group_id, p_country, v_actor, NULLIF(btrim(coalesce(p_reason, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION iam.revoke_country(p_group_id UUID, p_country VARCHAR)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_n INT;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  UPDATE iam.group_country_scopes SET revoked_at = now()
   WHERE group_id = p_group_id AND country = p_country AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;   -- 0 = nada vivo (idempotente); nunca DELETE (histórico)
END;
$$;

-- ── Membership ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.add_member(p_group_id UUID, p_user_id VARCHAR)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_id UUID;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.firebase_uid = p_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] usuário inexistente';
  END IF;
  SELECT id INTO v_id FROM iam.user_groups
   WHERE user_id = p_user_id AND group_id = p_group_id AND removed_at IS NULL;
  IF FOUND THEN RETURN v_id; END IF;   -- idempotente
  INSERT INTO iam.user_groups (user_id, group_id, tenant_id, assigned_by)
  VALUES (p_user_id, p_group_id, v_g.tenant_id, v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION iam.remove_member(p_group_id UUID, p_user_id VARCHAR)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_n INT;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);
  UPDATE iam.user_groups SET removed_at = now(), removed_by = v_actor
   WHERE group_id = p_group_id AND user_id = p_user_id AND removed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM iam._assert_not_last_manager(v_g.tenant_id);
  RETURN v_n;
END;
$$;

-- ── Grants: EXECUTE só às roles do app; PUBLIC não (mesmo padrão da 279) ──────
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'iam._require_master_membership(uuid)',
    'iam.update_group(uuid,text,text)', 'iam.archive_group(uuid)',
    'iam.set_group_permissions(uuid,uuid[],text)',
    'iam.grant_country(uuid,varchar,text)', 'iam.revoke_country(uuid,varchar)',
    'iam.add_member(uuid,varchar)', 'iam.remove_member(uuid,varchar)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime, app_system', f);
    END IF;
  END LOOP;
END
$$;

COMMIT;
