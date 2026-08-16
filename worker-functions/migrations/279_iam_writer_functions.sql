-- 279: escrita em iam.* SÓ por função SECURITY DEFINER (lex C4/C7; D115)
--
-- POR QUÊ: a 269 (e a 274) REVOGAM INSERT/UPDATE/DELETE nas tabelas que decidem o
-- isolamento das roles do app — "role confinada não forja o próprio grant". Mas o
-- painel PRECISA criar grupo, colocar gente, conceder país. A saída é a mesma do
-- Postgres para todo caso assim: funções SECURITY DEFINER (rodam como o dono das
-- tabelas) que VERIFICAM NO BANCO quem chama e o quê pode, e só então escrevem.
-- Nunca `GRANT INSERT ... TO app_runtime`. Na extração (D115) estas funções viram a
-- API do permission-service — o contrato já é "só por função".
--
-- Padrão de segurança de cada função (Postgres docs, "Writing SECURITY DEFINER
-- Functions Safely"):
--   · SET search_path = pg_catalog, iam, public  (sem search_path do chamador);
--   · REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE só a app_runtime/app_system;
--   · o ATOR vem de current_setting('app.user_uid') — nunca de parâmetro;
--   · gate: iam._require_manager() exige célula permission_management:write VIGENTE
--     (via iam.effective_permissions) e tenant; sem célula → EXCEPTION 42501;
--   · anti-lockout (lex C1/design 8): operação que deixaria ZERO staff ACTIVE com
--     permission_management:write vigente é rejeitada — checado DENTRO da transação;
--   · trilhas append-only gravadas na mesma transação (permission_group_changes,
--     country_feature_changes, *_by).
--
-- Escopo desta migration: as funções que o grupo 2 (use cases) chama. A leitura de
-- auditoria (C7) é iam.query_audit(...) — gated em permission_management:read e
-- registra o próprio ato em permission_audit_log.

-- ── Helpers privados ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam._actor()
RETURNS VARCHAR
LANGUAGE sql STABLE
SET search_path = pg_catalog, iam, public
AS $$
  SELECT NULLIF(current_setting('app.user_uid', true), '');
$$;

-- Sistema declarado (cron/boot) — usado só onde faz sentido (sync do manifest).
CREATE OR REPLACE FUNCTION iam._is_system_context()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog, iam, public
AS $$
  SELECT NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
     AND pg_has_role(current_user, 'app_system', 'MEMBER');
$$;

CREATE OR REPLACE FUNCTION iam._require_manager(p_tenant_id UUID)
RETURNS VARCHAR
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._actor();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] sem ator (app.user_uid vazio) — escrita em iam.* exige staff autenticado';
  END IF;
  IF NOT ('permission_management:write' = ANY (iam.effective_permissions(v_actor, p_tenant_id))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] permission_management:write ausente para o ator';
  END IF;
  RETURN v_actor;
END;
$$;

-- Anti-lockout: quantos staff ACTIVE, no tenant, teriam permission_management:write
-- vigente. Chamado APÓS a mutação, dentro da mesma transação: 0 → RAISE (rollback).
CREATE OR REPLACE FUNCTION iam._assert_not_last_manager(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_n INT;
BEGIN
  SELECT count(DISTINCT u.firebase_uid) INTO v_n
  FROM users u
  WHERE u.status = 'ACTIVE'
    AND 'permission_management:write' = ANY (iam.effective_permissions(u.firebase_uid, p_tenant_id));
  IF v_n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] operação rejeitada: deixaria ZERO gestores com permission_management:write (anti-lockout)';
  END IF;
END;
$$;

-- ── Grupos ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.create_group(p_tenant_id UUID, p_name TEXT, p_description TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._require_manager(p_tenant_id);
  v_id UUID;
BEGIN
  INSERT INTO iam.permission_groups (tenant_id, name, description, is_system, created_by)
  VALUES (p_tenant_id, p_name, p_description, false, v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

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

-- ── País ──────────────────────────────────────────────────────────────────────────
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
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = '[iam] concessão de país exige motivo';
  END IF;
  -- já vivo → idempotente (devolve o existente)
  SELECT id INTO v_id FROM iam.group_country_scopes
   WHERE group_id = p_group_id AND country = p_country AND revoked_at IS NULL;
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
  VALUES (p_group_id, p_country, v_actor, p_reason)
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
  UPDATE iam.group_country_scopes SET revoked_at = now()
   WHERE group_id = p_group_id AND country = p_country AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;   -- 0 = nada vivo (idempotente); nunca DELETE (histórico)
END;
$$;

-- ── Membership ────────────────────────────────────────────────────────────────────
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
  UPDATE iam.user_groups SET removed_at = now(), removed_by = v_actor
   WHERE group_id = p_group_id AND user_id = p_user_id AND removed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM iam._assert_not_last_manager(v_g.tenant_id);
  RETURN v_n;
END;
$$;

-- ── Disponibilidade por país ──────────────────────────────────────────────────────
-- Override pelo painel (gated em permission_management:write, tenant Enlite fixo hoje).
CREATE OR REPLACE FUNCTION iam.set_country_feature(p_country VARCHAR, p_feature_key VARCHAR, p_enabled BOOLEAN, p_config JSONB, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._require_manager(iam.current_tenant_id());
  v_prev iam.country_features%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = '[iam] override de feature exige motivo';
  END IF;
  SELECT * INTO v_prev FROM iam.country_features WHERE country = p_country AND feature_key = p_feature_key;
  INSERT INTO iam.country_feature_changes
    (country, feature_key, prev_enabled, prev_config, prev_source, new_enabled, new_config, new_source, reason, changed_by)
  VALUES
    (p_country, p_feature_key, v_prev.enabled, v_prev.config, v_prev.source, p_enabled, p_config, 'override', p_reason, v_actor);
  INSERT INTO iam.country_features (country, feature_key, enabled, config, source, reason, updated_by, updated_at)
  VALUES (p_country, p_feature_key, p_enabled, p_config, 'override', p_reason, v_actor, now())
  ON CONFLICT (country, feature_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, source = 'override',
        reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;

-- Sync do manifest no boot (contexto de SISTEMA declarado): grava/atualiza o DEFAULT
-- e NUNCA sobrescreve um override do painel.
CREATE OR REPLACE FUNCTION iam.sync_country_feature_default(p_country VARCHAR, p_feature_key VARCHAR, p_enabled BOOLEAN, p_config JSONB)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF NOT iam._is_system_context() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] sync do manifest só em contexto de sistema declarado';
  END IF;
  INSERT INTO iam.country_features (country, feature_key, enabled, config, source, updated_by, updated_at)
  VALUES (p_country, p_feature_key, p_enabled, p_config, 'default', 'system:manifest', now())
  ON CONFLICT (country, feature_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_by = 'system:manifest', updated_at = now()
    WHERE iam.country_features.source = 'default';   -- override intocado
END;
$$;

-- ── Leitura de auditoria (C7): gated + o ato registrado ───────────────────────────
-- Retorna as decisões de permissão (permission_audit_log) por filtros; o próprio
-- pedido vira uma linha ALLOW em permission_audit_log (resource='permission_audit',
-- action='read'). resource_access_log (270) permanece SELECT-revogado às roles do app.
CREATE OR REPLACE FUNCTION iam.query_audit(p_user_id VARCHAR, p_resource VARCHAR, p_since TIMESTAMPTZ, p_until TIMESTAMPTZ, p_limit INT)
RETURNS SETOF iam.permission_audit_log
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._actor();
  v_tenant UUID := iam.current_tenant_id();
BEGIN
  IF v_actor IS NULL OR NOT ('permission_management:read' = ANY (iam.effective_permissions(v_actor, v_tenant))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] permission_management:read ausente';
  END IF;
  INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision)
  VALUES (v_tenant, v_actor, 'permission_audit', 'read', COALESCE(p_user_id, p_resource), 'ALLOW');
  RETURN QUERY
    SELECT * FROM iam.permission_audit_log a
    WHERE a.tenant_id = v_tenant
      AND (p_user_id  IS NULL OR a.user_id  = p_user_id)
      AND (p_resource IS NULL OR a.resource = p_resource)
      AND (p_since    IS NULL OR a.created_at >= p_since)
      AND (p_until    IS NULL OR a.created_at <  p_until)
    ORDER BY a.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
END;
$$;

-- ── Grants: EXECUTE só às roles do app; PUBLIC não ─────────────────────────────────
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'iam._actor()', 'iam._is_system_context()', 'iam._require_manager(uuid)', 'iam._assert_not_last_manager(uuid)',
    'iam.create_group(uuid,text,text)', 'iam.update_group(uuid,text,text)', 'iam.archive_group(uuid)',
    'iam.set_group_permissions(uuid,uuid[],text)',
    'iam.grant_country(uuid,varchar,text)', 'iam.revoke_country(uuid,varchar)',
    'iam.add_member(uuid,varchar)', 'iam.remove_member(uuid,varchar)',
    'iam.set_country_feature(varchar,varchar,boolean,jsonb,text)',
    'iam.sync_country_feature_default(varchar,varchar,boolean,jsonb)',
    'iam.query_audit(varchar,varchar,timestamptz,timestamptz,int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime, app_system', f);
    END IF;
  END LOOP;
END
$$;
