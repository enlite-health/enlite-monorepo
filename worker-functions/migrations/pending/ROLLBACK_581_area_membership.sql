-- ROLLBACK_581_area_membership.sql — par de rollback da migration 581 (spec acesso-do-cliente, F1).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho.
-- ⚠️ Apaga o registro de vínculos (a trilha de concessão/revogação). Restaura o corpo de iam.remove_login da 580.
CREATE OR REPLACE FUNCTION iam.remove_login(p_provider TEXT, p_uid TEXT, p_actor_uid TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
BEGIN
  IF p_actor_uid IS NULL OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[iam] remove_login exige o ator (p_actor_uid)';
  END IF;
  UPDATE iam.person_login
     SET removed_at = now(), removed_reason = 'account_deleted'
   WHERE provider = p_provider AND uid = p_uid AND removed_at IS NULL;
END;
$$;
DROP FUNCTION IF EXISTS iam.effective_area_memberships(UUID);
DROP FUNCTION IF EXISTS iam.revoke_area_membership(UUID, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS iam.grant_area_membership(UUID, TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS iam.area_membership;
DROP FUNCTION IF EXISTS iam._area_membership_guard();
DROP FUNCTION IF EXISTS iam._area_membership_no_delete();
