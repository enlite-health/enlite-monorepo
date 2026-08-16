-- 276: funções de resolução — permissões e países EFETIVOS de um staff (D115)
--
-- POR QUÊ: a fonte única de "o que este staff pode e onde" tem que viver NO BANCO — a
-- policy RLS de país (278) e o resolver do app (3.1) chamam a mesma função, então
-- nunca divergem, e a role confinada nunca afirma os próprios países (lex C3).
--
-- Regras codificadas AQUI (e só aqui):
--   · staff precisa estar users.status = 'ACTIVE' (PENDING_ONBOARDING/SUSPENDED/
--     DEACTIVATED → nada; D-P2 do plano de junho);
--   · vínculo user_groups vivo (removed_at IS NULL) — 275;
--   · grupo não arquivado (archived_at IS NULL) — 275;
--   · escopo de país vivo (revoked_at IS NULL) — 268;
--   · célula não descontinuada (deprecated_at IS NULL) — 275;
--   · escopo por tenant (grupo do tenant certo).
--
-- SECURITY INVOKER (default) de propósito: as roles do app já têm SELECT em iam.* (274)
-- e em public.users; a função não eleva nada. STABLE: resultado constante dentro do
-- statement — a policy pode chamá-la por linha sem re-planejar.
--
-- A antiga public.get_user_effective_permissions(uid) da 206 vira wrapper deprecated
-- (sem tenant/status) para não quebrar leitores antigos; código novo usa iam.*.

CREATE OR REPLACE FUNCTION iam.effective_permissions(p_user_id VARCHAR, p_tenant_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT p.resource || ':' || p.action
    FROM iam.user_groups ug
    JOIN users u
      ON u.firebase_uid = ug.user_id
     AND u.status = 'ACTIVE'
    JOIN iam.permission_groups g
      ON g.id = ug.group_id
     AND g.tenant_id = p_tenant_id
     AND g.archived_at IS NULL
    JOIN iam.group_permissions gp
      ON gp.group_id = g.id
    JOIN iam.permissions p
      ON p.id = gp.permission_id
     AND p.deprecated_at IS NULL
    WHERE ug.user_id = p_user_id
      AND ug.removed_at IS NULL
    ORDER BY 1
  ), ARRAY[]::TEXT[]);
$$;
COMMENT ON FUNCTION iam.effective_permissions(VARCHAR, UUID) IS
  'União das células recurso:ação dos grupos VIVOS do staff (ACTIVE, não-arquivado, '
  'não-removido, não-deprecated), no tenant. Sem grupo → []. Fonte única (D115).';

CREATE OR REPLACE FUNCTION iam.effective_countries(p_user_id VARCHAR, p_tenant_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT gcs.country
    FROM iam.user_groups ug
    JOIN users u
      ON u.firebase_uid = ug.user_id
     AND u.status = 'ACTIVE'
    JOIN iam.permission_groups g
      ON g.id = ug.group_id
     AND g.tenant_id = p_tenant_id
     AND g.archived_at IS NULL
    JOIN iam.group_country_scopes gcs
      ON gcs.group_id = g.id
     AND gcs.revoked_at IS NULL
    WHERE ug.user_id = p_user_id
      AND ug.removed_at IS NULL
    ORDER BY 1
  ), ARRAY[]::TEXT[]);
$$;
COMMENT ON FUNCTION iam.effective_countries(VARCHAR, UUID) IS
  'Países concedidos pelos grupos VIVOS do staff, no tenant. Sem grupo → []. É o que a '
  'policy RLS de país (278) consulta — o app nunca afirma os próprios países (lex C3).';

-- Tenant padrão (Enlite) — o único hoje; a policy 278 usa este helper para não carregar
-- tenant no GUC. Quando houver 2º tenant, o resolver passa a setar app.tenant_id e a
-- policy lê daqui com fallback.
CREATE OR REPLACE FUNCTION iam.current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  );
$$;
COMMENT ON FUNCTION iam.current_tenant_id() IS
  'Tenant da request (GUC app.tenant_id) com fallback para o tenant Enlite fixo da 206.';

-- Wrapper deprecated da 206 (sem tenant/status): mantém leitores antigos vivos.
CREATE OR REPLACE FUNCTION public.get_user_effective_permissions(p_user_id VARCHAR)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT iam.effective_permissions(p_user_id, iam.current_tenant_id());
$$;
COMMENT ON FUNCTION public.get_user_effective_permissions(VARCHAR) IS
  'DEPRECATED (mig 276): use iam.effective_permissions(uid, tenant). Delegado.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.effective_permissions(VARCHAR, UUID) TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.effective_countries(VARCHAR, UUID)   TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION iam.current_tenant_id()                    TO app_runtime, app_system;
    GRANT EXECUTE ON FUNCTION public.get_user_effective_permissions(VARCHAR) TO app_runtime, app_system;
  END IF;
END
$$;
