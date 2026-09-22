-- ROLLBACK_458_iam_group_simulations.sql — par de rollback da migration 458
-- (iam_group_simulations, spec 026 "simular grupo de acesso", T1.7).
--
-- QUANDO USAR: lockout ou regressão de permissão detectados depois do deploy da 458 em prd — por
-- exemplo, `iam.effective_permissions` decidindo por um grupo simulado que não deveria mais estar
-- ativo, ou qualquer suspeita de que `iam.acting_groups` está devolvendo o grupo errado.
-- `iam.effective_permissions` está no caminho quente do engine LIGADO em prd (D406): este arquivo
-- existe para dar um caminho de volta RÁPIDO e SEGURO sem esperar um novo deploy.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `459_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 458 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_458_iam_group_simulations.sql
--
-- VI (constituição): NADA APAGA. Este rollback NÃO dropa `iam.group_simulations` (tabela e
-- histórico ficam), NÃO dropa `iam.permission_audit_log.simulation_id` (coluna e valores já
-- gravados ficam) e NÃO dropa as funções novas da 458 (`iam.is_master_member`,
-- `iam.active_group_simulation`, `iam.acting_groups`, `iam.start_group_simulation`,
-- `iam.end_group_simulation`) — elas ficam PRESENTES mas ÓRFÃS: continuam chamáveis (uma
-- simulação pode até ser aberta depois do rollback), mas `effective_permissions`/
-- `effective_countries` não leem mais `iam.acting_groups`, então nenhuma simulação — nova ou já
-- aberta no momento do rollback — volta a decidir nada. Rollback = desligar o EFEITO, não apagar o
-- DADO.
--
-- ACHADO AO ESCREVER ESTE ARQUIVO (não é decisão nova, é consequência mecânica de VI): colar o
-- texto de `iam.query_audit` da 283 LITERALMENTE (11 colunas, sem `simulation_id`) quebraria a
-- função em tempo de CHAMADA, não de CREATE — `iam.query_audit` é `RETURNS SETOF
-- iam.permission_audit_log`, e essa tabela TEM `simulation_id` (coluna que este rollback,
-- por VI, não dropa); o `RETURN QUERY SELECT` com 11 colunas não bate mais com o rowtype real
-- (12 colunas) e o erro só aparece quando alguém chama a função — o pior momento possível, durante
-- o próprio incidente que motivou o rollback. Por isso a 12ª coluna (`a.simulation_id`) foi
-- mantida no SELECT abaixo, como passthrough (os valores antigos continuam visíveis — histórico
-- honesto; nenhum caminho volta a escrever nela depois deste rollback). A lógica de mascaramento
-- por país (283, lex M2-5) é idêntica, byte-a-byte, ao resto.

BEGIN;

-- ── 1. effective_permissions/effective_countries: volta ao texto EXATO da 276 ─────
-- Fonte volta a ser iam.user_groups direto — nunca iam.acting_groups/simulação.
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
  'ROLLBACK 458 (spec 026, T1.7): texto restaurado da 276 — fonte volta a ser iam.user_groups '
  'direto, nunca iam.acting_groups. iam.group_simulations e as writers da 458 continuam existindo '
  '(VI) mas ficam INERTES: nenhuma simulação, nova ou já aberta, volta a decidir nada.';

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
  'ROLLBACK 458 (spec 026, T1.7): texto restaurado da 276 — mesma nota de effective_permissions '
  'acima. É o que a policy RLS de país (411, via session_may_see_country) volta a consultar.';

-- ── 2. _require_master_membership: volta ao texto EXATO da 456 ─────────────────────
-- Predicado inline (sem depender de iam.is_master_member, que fica órfã — presente, não dropada
-- por VI, só sem chamador). Comportamento idêntico ao de antes da 458.
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
  'ROLLBACK 458 (spec 026, T1.7): texto restaurado da 456 (predicado inline, sem '
  'iam.is_master_member). Spec 021, bloco 2: quando p_group_id é o Acesso Master, exige que o '
  'ator seja membro VIVO dele. Contexto de sistema passa direto.';

-- ── 3. query_audit: volta à lógica de mascaramento por país da 283 (DROP + CREATE, como a 283 fez
--    — a função depende do rowtype da tabela) — COM a 12ª coluna (simulation_id) mantida no SELECT
--    (ver nota "ACHADO" no cabeçalho: a tabela mantém a coluna, VI, então o SELECT precisa dela).
DROP FUNCTION IF EXISTS iam.query_audit(varchar,varchar,timestamptz,timestamptz,int);

CREATE FUNCTION iam.query_audit(p_user_id VARCHAR, p_resource VARCHAR, p_since TIMESTAMPTZ, p_until TIMESTAMPTZ, p_limit INT)
RETURNS SETOF iam.permission_audit_log
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor     VARCHAR := iam._actor();
  v_tenant    UUID    := iam.current_tenant_id();
  v_countries TEXT[];
  v_global    BOOLEAN;
BEGIN
  IF v_actor IS NULL OR NOT ('permission_management:read' = ANY (iam.effective_permissions(v_actor, v_tenant))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[iam] permission_management:read ausente';
  END IF;

  v_countries := iam.effective_countries(v_actor, v_tenant);
  -- Cobre todos os países suportados ⇒ não há "fora do escopo" a ocultar.
  v_global := iam.supported_countries() <@ COALESCE(v_countries, ARRAY[]::TEXT[]);

  -- O ato de auditar continua sendo auditado (280).
  INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision)
  VALUES (v_tenant, v_actor, 'permission_audit', 'read', COALESCE(p_user_id, p_resource), 'ALLOW');

  RETURN QUERY
    SELECT a.id,
           a.tenant_id,
           a.user_id,
           a.resource,
           a.action,
           CASE
             WHEN v_global THEN a.resource_id
             WHEN a.country IS NOT NULL AND a.country = ANY (COALESCE(v_countries, ARRAY[]::TEXT[]))
               THEN a.resource_id
             WHEN a.resource_id IS NULL THEN NULL
             ELSE '<oculto>'
           END,
           a.decision,
           a.ip_address,
           a.created_at,
           a.country,
           a.simulation_id   -- passthrough: coluna não dropada (VI); ninguém mais escreve nela.
    FROM iam.permission_audit_log a
    WHERE a.tenant_id = v_tenant
      AND (p_user_id  IS NULL OR a.user_id  = p_user_id)
      AND (p_resource IS NULL OR a.resource = p_resource)
      AND (p_since    IS NULL OR a.created_at >= p_since)
      AND (p_until    IS NULL OR a.created_at <  p_until)
    ORDER BY a.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION iam.query_audit(varchar,varchar,timestamptz,timestamptz,int) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.query_audit(varchar,varchar,timestamptz,timestamptz,int) TO app_runtime, app_system;
  END IF;
END
$$;

COMMIT;
