-- 296: anti-lockout pelos caminhos INDIRETOS (spec 002 §fora-de-escopo; lex C8 da 002; pré-F13)
--
-- NUMERAÇÃO: salta 286-295 de propósito — a linhagem `campos-admissao` (branch ainda não
-- mergeada em 28/08/2026) ocupa esses dez números; o runner ordena por nome, gap não quebra.
--
-- POR QUÊ: a 279 protege o último gestor (staff ACTIVE com permission_management:write
-- vigente) SÓ nas três operações do painel: remove_member, archive_group e
-- set_group_permissions. Três outros caminhos derrubavam o mesmo gestor sem nenhum
-- assert, medidos em 28/08/2026:
--   (b) `DELETE FROM users` (DELETE /api/admin/users/:id, AdminRepository.deleteByFirebaseUid)
--       — a FK iam.user_groups.user_id é ON DELETE CASCADE: a membership some junto;
--   (b') `UPDATE users SET status <> 'ACTIVE'` — iam.effective_permissions exige ACTIVE
--       (276), então desativar o último gestor o tira do IAM sem tocar em iam.*;
--   (c) iam.deprecate_missing_permission_cells (281) — se a varredura de rotas parar de
--       declarar permission_management:write, a célula ganha deprecated_at e some de
--       effective_permissions para TODOS os gestores de uma vez (foi a classe da D130).
--   (a) `PATCH /users/:id/role` NÃO é caminho de lockout do IAM: effective_permissions
--       ignora users.role, e o use case só aceita papel de staff. Provado por e2e, não
--       por trava (permission-anti-lockout-indirect.e2e.test.ts).
--
-- DESENHO:
--   · iam.is_last_manager(uid): verdadeiro se o uid é o ÚNICO gestor vivo em algum dos
--     tenants em que tem vínculo. Fonte única — o trigger e o pré-check TS chamam a mesma
--     função. Advisory xact lock por tenant, como na 279 (TOCTOU sob READ COMMITTED).
--   · trigger BEFORE DELETE OR UPDATE OF status ON users: NÃO escreve em iam.* (lex C4
--     intacta) e roda com a role do chamador — app_runtime já tem SELECT em iam.* (274) e
--     em users. Alcança psql e script, não só a rota.
--   · deprecate_missing_permission_cells: a família `permission_management` NUNCA é
--     descontinuada pelo sync. Ausência na lista viva vira WARNING (log do banco) — e o
--     repositório TS loga o mesmo. Remoção de verdade, se um dia houver, é migration
--     explícita, não efeito colateral de varredura. Alternativa considerada e descartada:
--     assert por tenant após o UPDATE — tenant sem gestor (QA hoje) faria o sync falhar
--     em todo boot, e D119 diz que boot não cai por catálogo.

-- ── is_last_manager ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.is_last_manager(p_user_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_tenant UUID;
  v_outros INT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  -- O tenant vem do VÍNCULO, não de users.tenant_id (que pode ser NULL em conta antiga).
  FOR v_tenant IN
    SELECT DISTINCT ug.tenant_id
      FROM iam.user_groups ug
     WHERE ug.user_id = p_user_id
       AND ug.removed_at IS NULL
  LOOP
    IF 'permission_management:write' = ANY (iam.effective_permissions(p_user_id, v_tenant)) THEN
      PERFORM pg_advisory_xact_lock(hashtext('iam:managers:' || v_tenant::text));
      -- Só quem tem vínculo vivo no tenant pode ser gestor: o JOIN corta a
      -- varredura de `users` (que guarda TODO mundo do Firebase) para o staff com grupo.
      SELECT count(DISTINCT u.firebase_uid) INTO v_outros
        FROM users u
        JOIN iam.user_groups ug2
          ON ug2.user_id = u.firebase_uid
         AND ug2.tenant_id = v_tenant
         AND ug2.removed_at IS NULL
       WHERE u.status = 'ACTIVE'
         AND u.firebase_uid <> p_user_id
         AND 'permission_management:write' = ANY (iam.effective_permissions(u.firebase_uid, v_tenant));
      IF v_outros = 0 THEN
        RETURN TRUE;
      END IF;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;
COMMENT ON FUNCTION iam.is_last_manager(VARCHAR) IS
  'TRUE se o staff é o ÚNICO ACTIVE com permission_management:write vigente em algum tenant '
  'em que tem vínculo vivo. Fonte única do anti-lockout indireto (trigger em users + pré-check '
  'do DELETE /users/:id). Toma advisory xact lock por tenant.';

-- ── trigger em users ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.trg_users_guard_last_manager()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  -- UPDATE só interessa quando a conta SAI de ACTIVE (é o que effective_permissions lê).
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'ACTIVE' AND NEW.status IS DISTINCT FROM 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  IF iam.is_last_manager(OLD.firebase_uid) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('[iam] %s rejeitado: deixaria ZERO gestores com permission_management:write (anti-lockout)', TG_OP);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_guard_last_manager ON users;
CREATE TRIGGER trg_users_guard_last_manager
  BEFORE DELETE OR UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION iam.trg_users_guard_last_manager();

-- ── deprecate_missing_permission_cells: a família de gestão não se descontinua ───
CREATE OR REPLACE FUNCTION iam.deprecate_missing_permission_cells(
  p_owner_service VARCHAR,
  p_live_keys     TEXT[]
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_n INT;
  v_protegida TEXT;
BEGIN
  IF NOT iam._is_system_context() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[iam] descontinuar célula exige app.system_context declarado';
  END IF;
  IF p_live_keys IS NULL OR cardinality(p_live_keys) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] lista de células vivas VAZIA — descontinuaria o catálogo inteiro (fail-closed)';
  END IF;

  -- Célula protegida ausente da varredura é SINTOMA (rota sumiu, família fora do
  -- perímetro, scanner quebrado) — nunca motivo para tirar o acesso de todo gestor.
  FOREACH v_protegida IN ARRAY ARRAY['permission_management:read', 'permission_management:write'] LOOP
    IF NOT (v_protegida = ANY (p_live_keys)) THEN
      RAISE WARNING '[iam] célula protegida % ausente da varredura — mantida no catálogo (anti-lockout)', v_protegida;
    END IF;
  END LOOP;

  UPDATE iam.permissions p
     SET deprecated_at = now()
   WHERE COALESCE(p.owner_service, 'worker-functions') = COALESCE(p_owner_service, 'worker-functions')
     AND p.deprecated_at IS NULL
     AND p.resource <> 'permission_management'
     AND NOT ((p.resource || ':' || p.action) = ANY (p_live_keys));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION iam.deprecate_missing_permission_cells(VARCHAR, TEXT[]) IS
  'Descontinua (deprecated_at) as células DESTE serviço que sumiram do código; lista vazia levanta '
  'exceção (uma varredura falha tiraria o acesso de todo mundo). A família permission_management '
  'NUNCA é descontinuada aqui (296, anti-lockout) — ausência vira WARNING. Nunca DELETE.';

-- ── ACL ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- REVOKE e GRANT dentro da MESMA guarda: num banco sem as roles do app (dev
  -- novo), revogar de PUBLIC sem conceder a ninguém faria o trigger estourar
  -- 42501 para qualquer role que mexa em `users`.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION iam.is_last_manager(varchar) FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.trg_users_guard_last_manager() FROM PUBLIC;
    REVOKE ALL ON FUNCTION iam.deprecate_missing_permission_cells(varchar,text[]) FROM PUBLIC;
    -- O trigger roda como quem faz o DELETE/UPDATE: as duas roles precisam EXECUTAR o check.
    GRANT EXECUTE ON FUNCTION iam.is_last_manager(varchar) TO app_runtime, app_system;
    -- CREATE OR REPLACE preserva a ACL da 281, mas re-afirmar é mais barato que supor.
    REVOKE ALL ON FUNCTION iam.deprecate_missing_permission_cells(varchar,text[]) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION iam.deprecate_missing_permission_cells(varchar,text[]) TO app_system;
  END IF;
END
$$;
