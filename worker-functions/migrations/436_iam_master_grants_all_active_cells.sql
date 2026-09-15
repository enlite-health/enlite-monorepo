-- 436 — Acesso Master recebe automaticamente toda célula ATIVA do catálogo (D338, PR-8c)
--
-- POR QUÊ: D338 (15/09/2026, decisão do Gabriel) — a D285 ("célula nova nasce com 0 grupos")
-- deixa de valer SÓ para o Acesso Master (id fixo a0000000-0000-0000-0000-000000000001, seed
-- 206). Achado que motivou (prova do PR-4 na stage, 15/09): `qa.admin` — só no Master — levou
-- 403 `missing_cell` em `patient_consent_documents:read`, porque a tela do Master é somente
-- leitura (não concede célula pela UI) e o sync do catálogo (281/C10) nunca dava célula a
-- grupo nenhum. Medição do mesmo dia: Master ficou 39 células atrás do catálogo (`messaging:*`,
-- `patient_identity`, `catalog_therapeutic_*` etc.), porque esta migration só converte grant
-- que já existia. Para todo OUTRO grupo a D285 continua valendo sem alteração nenhuma.
--
-- O QUE FAZ:
--   1. CATCH-UP (roda AGORA, como parte desta migration): concede ao Master as células ATIVAS
--      que faltam hoje. Não depende de `PERMISSION_CATALOG_SYNC_ENABLED` (ausente em PRD) — é
--      SQL direto, executado pelo dono da migration. Ramifica `iam` × `public`, no molde da 432
--      (`migration-manual-precisa-registrar`: um `run-migration-prod.sh` manual pode rodar numa
--      base ainda em `public`, seed 206 cru, sem a coluna `deprecated_at` que só a 275 adiciona
--      em `iam.permissions` — por isso o ramo `public` não filtra por ela).
--   2. Função `iam.grant_active_permissions_to_master()`, SECURITY DEFINER, MESMO gate da 281
--      (ACL só `app_system` + `app.system_context` declarado): INSERT idempotente (ON CONFLICT
--      DO NOTHING) em `iam.group_permissions` para toda célula com `deprecated_at IS NULL`.
--      `PgPermissionCatalogRepository.sync()` passa a chamá-la a cada boot com o catálogo
--      sincronizado — é o mecanismo que faz célula NASCIDA DEPOIS chegar ao Master sem ação
--      humana, e também RECONCILIA se alguém tirar célula do Master por `PUT
--      /permission-groups/:id/permissions` direto (achado fora do escopo: `iam.set_group_
--      permissions`, mig 279, não checa `is_system` — decisão pendente do Gabriel).
--
-- O QUE NÃO FAZ: não mexe em NENHUM outro grupo (D285 intacta para eles); nunca REMOVE grant
-- (só `ON CONFLICT DO NOTHING`, nunca DELETE); nunca descontinua célula.
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE group_id = 'a0000...0001' AND permission_id
-- IN (<lista logada pelo NOTICE abaixo, se precisar desfazer>)` + `DROP FUNCTION
-- iam.grant_active_permissions_to_master()`. Nenhuma linha de `iam.permissions` é tocada.

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  -- Ramo iam (stage e qualquer base já extraída pela 274).
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[436] catch-up iam.group_permissions: % células concedidas ao Acesso Master', v_n;
  END IF;

  -- Ramo public (PRD ainda no seed 206 cru — só age se for TABELA de verdade, não a view
  -- de compatibilidade SELECT-only da 274, no mesmo molde de checagem da 432).
  IF to_regclass('public.permission_groups') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'permission_groups' AND c.relkind = 'r'
     )
  THEN
    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM public.permissions p
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[436] catch-up public.group_permissions: % células concedidas ao Acesso Master', v_n;
  END IF;
END
$$;

-- ── Função de boot (mesmo gate da 281) — só criada se o schema iam existir; em base
-- ainda em `public` (pré-274) o mecanismo de reconciliação por boot não se aplica porque
-- `PERMISSION_CATALOG_SYNC_ENABLED` também não roda contra `public.*` (a feature é iam-only).
DO $outer$
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION iam.grant_active_permissions_to_master()
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, iam, public
      AS $fn$
      DECLARE
        v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
        v_n INT;
      BEGIN
        IF NOT iam._is_system_context() THEN
          RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = '[iam] conceder ao Acesso Master exige app.system_context declarado';
        END IF;

        INSERT INTO iam.group_permissions (group_id, permission_id)
        SELECT v_master_id, p.id
          FROM iam.permissions p
         WHERE p.deprecated_at IS NULL
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n;
      END;
      $fn$
    $ddl$;

    EXECUTE $c$COMMENT ON FUNCTION iam.grant_active_permissions_to_master() IS
      'D338: o Acesso Master (id fixo) recebe automaticamente toda célula ATIVA do catálogo, '
      'a cada sync de boot. INSERT idempotente (ON CONFLICT DO NOTHING) — nunca remove grant, '
      'nunca concede a outro grupo. A D285 ("célula nova nasce com 0 grupos") continua valendo '
      'para todos os demais grupos; esta função é a exceção nomeada só para o Master.'$c$;

    EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_active_permissions_to_master() FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      -- Gate por ROLE = ACL: só o pool de SISTEMA (app_system) sincroniza; app_runtime,
      -- mesmo forjando app.system_context, não consegue nem chamar (padrão da 281/279).
      EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_active_permissions_to_master() FROM app_runtime';
      EXECUTE 'GRANT EXECUTE ON FUNCTION iam.grant_active_permissions_to_master() TO app_system';
    END IF;
  END IF;
END
$outer$;

COMMIT;
