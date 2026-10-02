-- 471 — célula `own_*` NOVA (nascida DEPOIS do boot, pelo sync do catálogo) passa a ser
-- concedida a TODO GRUPO ATIVO automaticamente — não só ao Acesso Master (change
-- 022-ux-mencao-e-notificacao, revogação ESTREITA da D338/C10, decisão do Gabriel 23/09/2026)
--
-- POR QUÊ: as migrations 464/466/467/468/469/470 já fecharam o PASSADO (catch-up para grupo já
-- existente) e o lado da CRIAÇÃO (`iam.create_group` concede `own_*` já ao nascer, mig 469). O
-- eixo que ainda ficava aberto é o OPOSTO: quando uma célula `own_*` NOVA entra no catálogo pelo
-- SYNC DE BOOT (`PgPermissionCatalogRepository.sync()`, a partir de uma rota nova que declara
-- `perm.require('own_algumacoisa', 'acao')`), os grupos JÁ EXISTENTES não a recebem — hoje só o
-- Acesso Master recebe automaticamente, via `iam.grant_active_permissions_to_master()` (mig 436).
-- É a MESMA classe de incidente que motivou 464-470 (145 DENY de `own_presence:update`/6h,
-- 111 DENY de notificação/2h em prd), só que no gatilho "célula nasceu", não "grupo nasceu".
--
-- DECISÃO DO GABRIEL (23/09/2026) — revogação ESTREITA da D338, só para `own_*`: célula cujo
-- `resource` começa com `own_` não dá acesso a dado de TERCEIRO — dá acesso ao PRÓPRIO registro
-- do usuário autenticado (marcar a própria notificação como lida, marcar a própria presença).
-- Sem ela o app quebra para a pessoa; concedê-la a todo grupo ativo não abre superfície de
-- acesso a paciente, worker ou qualquer dado alheio. Toda célula NÃO-own continua exatamente
-- como hoje: nasce com 0 grupos (D285), nunca entra sozinha — só o Master a recebe (D338).
--
-- O QUE FAZ:
--   Função `iam.grant_own_cells_to_active_groups()`, SECURITY DEFINER, MESMO gate de sistema das
--   funções vizinhas (`grant_active_permissions_to_master`/436, `grant_master_fixed_accounts`/451):
--   INSERT idempotente (ON CONFLICT DO NOTHING) em `iam.group_permissions` para TODO grupo com
--   `archived_at IS NULL`, de TODA célula com `resource LIKE 'own\_%' ESCAPE '\'` (MESMO filtro
--   de prefixo das migrations 464/466/467/468/469/470 — nenhuma lista hardcoded de resources) e
--   `deprecated_at IS NULL`. `PgPermissionCatalogRepository.sync()` passa a chamá-la a cada boot,
--   NA MESMA TRANSAÇÃO, logo após `grant_active_permissions_to_master()` — é o mecanismo que faz
--   `own_*` NASCIDA DEPOIS chegar a todo staff sem catch-up manual nem migration nova por célula.
--
-- O QUE NÃO FAZ: não concede NENHUMA célula fora do prefixo `own_` (a D285/D338 continuam
-- intactas para o resto do catálogo — só o Master recebe automaticamente célula não-own); nunca
-- concede a grupo arquivado; nunca REMOVE grant (só `ON CONFLICT DO NOTHING`, nunca DELETE);
-- nunca descontinua célula.
--
-- ROLLBACK: `DROP FUNCTION iam.grant_own_cells_to_active_groups()` + remover a chamada em
-- `PgPermissionCatalogRepository.sync()`. Não desfaz grants já concedidos enquanto a função
-- esteve ativa (mesma lógica "não desfaz o que já fechou o bug" das migrations vizinhas) — a
-- lista exata concedida sai do `RAISE NOTICE` abaixo, se precisar reconstruir para um DELETE
-- manual.

BEGIN;

DO $outer$
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.permissions') IS NOT NULL THEN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION iam.grant_own_cells_to_active_groups()
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, iam, public
      AS $fn$
      DECLARE
        v_n INT;
      BEGIN
        IF NOT iam._is_system_context() THEN
          RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = '[iam] conceder own_* a todo grupo ativo exige app.system_context declarado';
        END IF;

        INSERT INTO iam.group_permissions (group_id, permission_id)
        SELECT g.id, p.id
          FROM iam.permission_groups g
          CROSS JOIN iam.permissions p
         WHERE g.archived_at IS NULL
           AND p.resource LIKE 'own\_%' ESCAPE '\'
           AND p.deprecated_at IS NULL
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RAISE NOTICE '[471] own_* concedida a todo grupo ativo no sync de boot: % linhas novas', v_n;
        RETURN v_n;
      END;
      $fn$
    $ddl$;

    EXECUTE $c$COMMENT ON FUNCTION iam.grant_own_cells_to_active_groups() IS
      'Revogação ESTREITA da D338/C10 (mig 471, decisão do Gabriel 23/09/2026): toda célula '
      'own_* (resource LIKE ''own\_%'' ESCAPE ''\''), ATIVA, é concedida a TODO grupo ATIVO a '
      'cada sync de boot — nunca a grupo arquivado, nunca célula fora do prefixo own_. Chamada '
      'por PgPermissionCatalogRepository.sync() logo após grant_active_permissions_to_master(). '
      'D285/D338 continuam intactas para qualquer célula NÃO-own (só o Master a recebe).'$c$;

    EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_own_cells_to_active_groups() FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE 'REVOKE ALL ON FUNCTION iam.grant_own_cells_to_active_groups() FROM app_runtime';
      EXECUTE 'GRANT EXECUTE ON FUNCTION iam.grant_own_cells_to_active_groups() TO app_system';
    END IF;

    -- CATCH-UP (roda AGORA): fecha o gap também para as 3 células own_ já existentes hoje,
    -- caso algum grupo ativo tenha ficado de fora por qualquer via que não 468/469 (idempotente,
    -- mesmo corpo). ⚠️ CORREÇÃO (23/09, achado ao aplicar contra Postgres real): a função exige
    -- `app.system_context` declarado (mesmo gate da 436/451) — a sessão do RUNNER de migration
    -- não o declara, então o `PERFORM` cru falhava com 42501 antes desta linha existir. Declarado
    -- LOCAL à transação (`set_config(..., true)`, mesmo padrão de `withSystemWrite`/dbAccess.ts) —
    -- nunca persiste fora desta migration, só autoriza o catch-up abaixo.
    PERFORM set_config('app.system_context', 'migration:471', true);
    PERFORM iam.grant_own_cells_to_active_groups();
  END IF;
END
$outer$;

COMMIT;
