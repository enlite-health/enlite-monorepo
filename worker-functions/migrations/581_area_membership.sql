-- 581: iam.area_membership — vínculo (pessoa × área × papel) guardado (spec acesso-do-cliente, F1, D644/D645/D647)
--
-- DONO ÚNICO (D514): só entra aqui o que NÃO tem dono em outro lugar. `backoffice`·staff deriva do login
-- (isStaffAccount) e `care`·worker de `workers.auth_uid`; gravá-los seria duplicar. `clinic` não tem papel
-- permitido (DF-10). O CHECK `area_membership_area_role` é a ÚNICA lista de pares válidos no banco; a cópia no
-- código é `identity/domain/Area.ts` (paridade provada no e2e de schema).
--
-- ESCRITA SÓ POR FUNÇÃO SECURITY DEFINER (mig 279). O schema `iam` ainda concede, por privilégio PADRÃO de tabela
-- futura, SELECT/INSERT/UPDATE/DELETE a app_runtime/app_system (274:141-143, LISTA 19): a tabela nasce com escrita
-- aberta. Esta migration REVOGA a escrita na própria tabela e concede SELECT explícito. Sem alteração de
-- privilégio padrão (proibido) e sem REVOKE no dono (551: a migration roda como `enlite_app`, LOGIN sem superuser).
--
-- [ESCOLHA MINHA] o ator vem por PARÂMETRO (`p_actor_uid`), como em `iam.remove_login` (580, A2), e não de
-- `app.user_uid` (279): quem chama é a rota de staff já autorizada por `area_membership:write`; o banco só exige
-- ator não vazio e o grava em granted_by/revoked_by (uid de ator, SEM FK — DF-17).
--
-- Também redefine `iam.remove_login` (mesma assinatura, CREATE OR REPLACE; a 580 ficou intacta): conta apagada
-- deixa a árvore sem login vivo → vínculos vivos revogados com reason='account_deleted' (DF-20, design §2.2).
-- Rollback: migrations/pending/ROLLBACK_581_area_membership.sql (restaura o corpo de remove_login da 580).

-- ── 1. Tabela ───────────────────────────────────────────────────────────────────────
CREATE TABLE iam.area_membership (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID        NOT NULL REFERENCES iam.person(id),
  area        TEXT        NOT NULL,
  role        TEXT        NOT NULL,
  granted_by  TEXT        NOT NULL CHECK (length(trim(granted_by)) > 0),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by  TEXT,
  revoked_at  TIMESTAMPTZ,
  reason      TEXT,
  CONSTRAINT area_membership_area_role CHECK (
    (area = 'care'  AND role = 'family') OR
    (area = 'learn' AND role IN ('learner', 'teacher', 'manager'))
  ),
  CONSTRAINT area_membership_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) > 0)  -- IS NOT NULL explícito: CHECK com NULL passa (LISTA 20)
  )
);

-- um vínculo VIVO por (pessoa, área, papel); o papel está na chave de propósito (DF-21)
CREATE UNIQUE INDEX uq_area_membership_live
  ON iam.area_membership (person_id, area, role) WHERE revoked_at IS NULL;

COMMENT ON TABLE iam.area_membership IS
  'Vínculo guardado pessoa x área x papel (D644). Só o que não tem dono em outro lugar (backoffice·staff e care·worker são derivados). Append-only: revogação é um registro, nunca DELETE. Escrita só por iam.grant_area_membership / iam.revoke_area_membership.';
COMMENT ON COLUMN iam.area_membership.person_id IS
  'iam.person.id (D647). A concessão vai sempre à raiz; a leitura sobe/desce a árvore de merged_into_id.';
COMMENT ON COLUMN iam.area_membership.revoked_at IS
  'NULL = vínculo vivo (único significado). Preenchido junto de revoked_by e reason (CHECK area_membership_revocation_complete).';
COMMENT ON COLUMN iam.area_membership.reason IS
  'Motivo da REVOGAÇÃO (NULL enquanto vivo).';

-- ── 2. Triggers (append-only) ───────────────────────────────────────────────────────
CREATE FUNCTION iam._area_membership_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23000',
    MESSAGE = '[iam] iam.area_membership é append-only: DELETE recusado (revogue com iam.revoke_area_membership)';
END;
$$;

CREATE FUNCTION iam._area_membership_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  -- só revoked_* muda, e só UMA vez (de vivo para revogado)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.area IS DISTINCT FROM OLD.area OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] iam.area_membership: só revoked_by, revoked_at e reason mudam';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] iam.area_membership: vínculo já revogado é imutável (revoked_* é preenchido uma única vez)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER area_membership_no_delete BEFORE DELETE ON iam.area_membership
  FOR EACH ROW EXECUTE FUNCTION iam._area_membership_no_delete();
CREATE TRIGGER area_membership_guard BEFORE UPDATE ON iam.area_membership
  FOR EACH ROW EXECUTE FUNCTION iam._area_membership_guard();

-- ── 3. Privilégios da tabela: leitura explícita, escrita NUNCA direta (LISTA 19) ────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON iam.area_membership FROM app_runtime, app_system;
    GRANT SELECT ON iam.area_membership TO app_runtime, app_system;
  END IF;
END $$;

-- ── 4. Funções ──────────────────────────────────────────────────────────────────────
-- 4.1 Conceder: sempre à RAIZ (pessoa absorvida recusada). Idempotente: se a árvore já tem o vínculo vivo,
--     devolve o id existente sem gravar outra linha.
CREATE FUNCTION iam.grant_area_membership(p_person_id UUID, p_area TEXT, p_role TEXT, p_actor_uid TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_merged UUID;
  v_found BOOLEAN;
  v_id UUID;
BEGIN
  IF p_actor_uid IS NULL OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] grant_area_membership exige o ator (p_actor_uid)';
  END IF;
  SELECT p.merged_into_id, true INTO v_merged, v_found FROM iam.person p WHERE p.id = p_person_id;
  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = '[iam] grant_area_membership: pessoa inexistente';
  END IF;
  IF v_merged IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[iam] grant_area_membership: pessoa absorvida não recebe vínculo (conceda à raiz)';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('iam:area_membership:' || p_person_id::text));
  SELECT m.id INTO v_id
  FROM iam.area_membership m
  WHERE m.person_id IN (SELECT iam.person_tree(p_person_id))
    AND m.area = p_area AND m.role = p_role AND m.revoked_at IS NULL
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  INSERT INTO iam.area_membership (person_id, area, role, granted_by)
  VALUES (p_person_id, p_area, p_role, p_actor_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 4.2 Revogar: (area, role) em TODA pessoa da árvore (senão a união continua mostrando o vínculo, D648).
--     Devolve quantas linhas revogou (0 = nada vivo). Motivo obrigatório.
CREATE FUNCTION iam.revoke_area_membership(p_person_id UUID, p_area TEXT, p_role TEXT, p_actor_uid TEXT, p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_actor_uid IS NULL OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] revoke_area_membership exige o ator (p_actor_uid)';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] revoke_area_membership exige o motivo (p_reason)';
  END IF;
  UPDATE iam.area_membership
     SET revoked_at = now(), revoked_by = p_actor_uid, reason = p_reason
   WHERE person_id IN (SELECT iam.person_tree(p_person_id))
     AND area = p_area AND role = p_role AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- 4.3 Leitura do registro: vínculos VIVOS da árvore da pessoa (raiz + absorvidas), DISTINCT (area, role).
CREATE FUNCTION iam.effective_area_memberships(p_person_id UUID)
RETURNS TABLE (area TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
  SELECT DISTINCT m.area, m.role
  FROM iam.area_membership m
  WHERE m.person_id IN (SELECT iam.person_tree(p_person_id))
    AND m.revoked_at IS NULL
  ORDER BY m.area, m.role;
$$;

-- 4.4 remove_login redefinido (mesma assinatura da 580): além de marcar o login removido, se a ÁRVORE ficou sem
--     login vivo, revoga todo vínculo vivo dela com reason='account_deleted', revoked_by = ator (DF-20).
CREATE OR REPLACE FUNCTION iam.remove_login(p_provider TEXT, p_uid TEXT, p_actor_uid TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_person UUID;
BEGIN
  IF p_actor_uid IS NULL OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] remove_login exige o ator (p_actor_uid)';
  END IF;
  UPDATE iam.person_login
     SET removed_at = now(), removed_reason = 'account_deleted'
   WHERE provider = p_provider AND uid = p_uid AND removed_at IS NULL
  RETURNING person_id INTO v_person;
  IF v_person IS NULL THEN
    RETURN;  -- login inexistente ou já removido: nada a revogar
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM iam.person_login l
    WHERE l.person_id IN (SELECT iam.person_tree(v_person)) AND l.removed_at IS NULL
  ) THEN
    UPDATE iam.area_membership
       SET revoked_at = now(), revoked_by = p_actor_uid, reason = 'account_deleted'
     WHERE person_id IN (SELECT iam.person_tree(v_person)) AND revoked_at IS NULL;
  END IF;
END;
$$;

-- ── 5. GRANT EXECUTE explícito (nunca PUBLIC) ───────────────────────────────────────
REVOKE ALL ON FUNCTION
  iam._area_membership_no_delete(), iam._area_membership_guard(),
  iam.grant_area_membership(UUID, TEXT, TEXT, TEXT),
  iam.revoke_area_membership(UUID, TEXT, TEXT, TEXT, TEXT),
  iam.effective_area_memberships(UUID)
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    GRANT EXECUTE ON FUNCTION
      iam.grant_area_membership(UUID, TEXT, TEXT, TEXT),
      iam.revoke_area_membership(UUID, TEXT, TEXT, TEXT, TEXT),
      iam.effective_area_memberships(UUID)
    TO app_runtime, app_system;
  END IF;
END $$;
