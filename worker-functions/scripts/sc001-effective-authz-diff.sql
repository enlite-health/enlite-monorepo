-- sc001-effective-authz-diff.sql — SC-001 (T1.4, spec 026, BLOQUEANTE da F1)
--
-- POR QUÊ: iam.effective_permissions/iam.effective_countries (migration 458) trocaram a fonte de
-- grupos de iam.user_groups para iam.acting_groups (COALESCE simulação↔grupos reais). Esta régua
-- prova que, SEM simulação aberta, o resultado continua byte-a-byte igual ao da 276 (antes da
-- 458) para TODO par (users.firebase_uid × iam.tenants.id). `iam.effective_permissions` está no
-- caminho quente do engine LIGADO em prd (D406) — um diff ≠ 0 aqui é lockout/vazamento em
-- potencial (regra de continuidade da spec 026: PARA e volta ao Gabriel, não "ajusta o teste").
--
-- Roda inteiro dentro de BEGIN...ROLLBACK: cria o schema sc001 só para o diff e nunca persiste —
-- seguro para rodar contra prd/stage (T4.3, com `-v VERBOSITY=terse` para não ecoar DETAIL de erro
-- com PII: psql-vars-terse).
--
-- O bloco entre os marcadores "GERADO" é COPIADO de migrations/276_effective_authz_functions.sql,
-- trocando só o NOME das 2 funções (iam.effective_permissions/iam.effective_countries →
-- sc001.effective_permissions/sc001.effective_countries) — nada mais: iam.user_groups,
-- iam.permission_groups, iam.group_permissions, iam.permissions, iam.group_country_scopes
-- continuam apontando para iam, porque é a versão PRÉ-458 (fonte = user_groups direto) que o diff
-- precisa como referência. NÃO EDITAR À MÃO — regenerar com:
--
--   awk '/^CREATE OR REPLACE FUNCTION iam\.effective_permissions/,/^\$\$;$/ {print} \
--        /^CREATE OR REPLACE FUNCTION iam\.effective_countries/,/^\$\$;$/ {print}' \
--     migrations/276_effective_authz_functions.sql \
--   | sed -e 's/iam\.effective_permissions/sc001.effective_permissions/g' \
--         -e 's/iam\.effective_countries/sc001.effective_countries/g'
--
-- tests/e2e/sc001-effective-authz-diff.e2e.test.ts replica esse comando em TypeScript e compara o
-- resultado byte-a-byte com o bloco abaixo — se divergir, o teste falha: o script standalone
-- envelheceu (a 276 mudou e este arquivo não foi regenerado).

BEGIN;

CREATE SCHEMA sc001;

-- ===== GERADO (início) =====
CREATE OR REPLACE FUNCTION sc001.effective_permissions(p_user_id VARCHAR, p_tenant_id UUID)
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

CREATE OR REPLACE FUNCTION sc001.effective_countries(p_user_id VARCHAR, p_tenant_id UUID)
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
-- ===== GERADO (fim) =====

WITH pares AS (
  SELECT u.firebase_uid AS uid, t.id AS tenant
  FROM users u CROSS JOIN iam.tenants t
),
diffs AS (
  SELECT
    pares.uid,
    pares.tenant,
    (
      EXISTS (
        SELECT x FROM unnest(iam.effective_permissions(pares.uid, pares.tenant)) x
        EXCEPT
        SELECT x FROM unnest(sc001.effective_permissions(pares.uid, pares.tenant)) x
      )
      OR EXISTS (
        SELECT x FROM unnest(sc001.effective_permissions(pares.uid, pares.tenant)) x
        EXCEPT
        SELECT x FROM unnest(iam.effective_permissions(pares.uid, pares.tenant)) x
      )
    ) AS diff_perm,
    (
      EXISTS (
        SELECT x FROM unnest(iam.effective_countries(pares.uid, pares.tenant)) x
        EXCEPT
        SELECT x FROM unnest(sc001.effective_countries(pares.uid, pares.tenant)) x
      )
      OR EXISTS (
        SELECT x FROM unnest(sc001.effective_countries(pares.uid, pares.tenant)) x
        EXCEPT
        SELECT x FROM unnest(iam.effective_countries(pares.uid, pares.tenant)) x
      )
    ) AS diff_country
  FROM pares
)
SELECT format(
  'usuarios=%s tenants=%s pares=%s diff_permissions=%s diff_countries=%s',
  (SELECT count(*) FROM users),
  (SELECT count(*) FROM iam.tenants),
  (SELECT count(*) FROM diffs),
  (SELECT count(*) FROM diffs WHERE diff_perm),
  (SELECT count(*) FROM diffs WHERE diff_country)
) AS linha;

ROLLBACK;
