-- 453 — deprecia as 22 células `<recurso>:write` legadas que a 435 splitou em create/update
--
-- POR QUÊ: a 435 (SUP-31) manteve a linha `write` dos 23 recursos splitados no catálogo, para
-- não tirar acesso de grupo que ainda não tinha migrado para create/update. Medição em produção
-- feita nesta task (Postgres prd, tabelas `permissions`/`group_permissions`/`permission_groups`,
-- 20/09/2026): das 25 células `:write` vivas, 23 são hoje 100% REDUNDANTES por GRANTS — TODO
-- grupo que tem a `write` de um desses recursos também tem a `create` E a `update` do MESMO
-- recurso. Mas medir grants sozinho NÃO BASTA (achado da revisão pós-#438/#439, 20/09/2026):
-- redundância de GRANT não prova ausência de checagem LITERAL da string `<recurso>:write` em
-- código de produção. `iam.effective_permissions()` (migration 276) exclui célula com
-- `deprecated_at` do vetor efetivo — se algum caminho de código ainda faz
-- `cells.includes('<recurso>:write')` (ou equivalente), depreciar a `write` derruba esse
-- caminho com 403 mesmo para quem tem o grant, apesar de "zero órfãos" nos grants. Achado
-- concreto: `worker-functions/src/modules/case/application/therapeuticProjectAccess.ts:25,53`
-- faz exatamente isso para `patient_clinical:write` (`PATIENT_CLINICAL_WRITE_CELL`), consumido
-- em `AdminTherapeuticProjectsController.ts:187` — duas suítes e2e (`therapeutic-projects-api`,
-- `therapeutic-projects-pr7-api`) provaram a quebra. Por isso a exclusão desta migration agora
-- tem DOIS critérios, não um: (a) recurso sem `create`/`update` no catálogo — `permission_management`
-- e `upload`, nunca foram splitados; (b) recurso com checagem LITERAL de `:write` em código de
-- produção (grep `worker-functions/src`, fora de `__tests__`) — `patient_clinical`, por causa do
-- `therapeuticProjectAccess.ts` acima. Os outros 22 recursos splitados foram varridos (20/09/2026)
-- e não têm checagem literal remanescente: rotas já pedem `create`/`update` desde o PR-8b.4, e os
-- únicos hits de `:write` fora de rota são comentário/docstring ou lista morta sem caller
-- (`ActorClass.ts:34`, deny-list de concessão a terceiro — não gate de request). Por isso a lista
-- abaixo é NOMEADA, não `WHERE action = 'write'` genérico — um filtro genérico pegaria os 3
-- excluídos (os 2 originais + `patient_clinical`).
--
-- MECANISMO: `deprecated_at` em `iam.permissions` (coluna já existe desde a 274/281).
-- `PgPermissionCatalogRepository.list()` (src/modules/identity/permissions/infrastructure/
-- PgPermissionCatalogRepository.ts:47-56) só devolve célula com `deprecated_at IS NULL` a menos
-- que `includeDeprecated: true` seja pedido — é o mesmo filtro que a UI de grupo usa para não
-- oferecer célula depreciada em grupo novo. `idsByCellKey` (linhas 67-79) tem o mesmo filtro.
--
-- O QUE FAZ: UPDATE de `deprecated_at = now()` nas 22 linhas `<recurso>:write` nomeadas —
-- só nas que ainda estão `deprecated_at IS NULL` (idempotente: rodar 2× não muda nada na 2ª).
-- NÃO REMOVE linha nenhuma de `iam.permissions` nem de `group_permissions` — os grants
-- continuam lá, intocados; o acesso efetivo de ninguém muda, porque `create`+`update` já cobrem
-- (medido, zero órfãos). Espelha em `public.permissions` só se essa tabela física existir
-- (mesmo guard das migrations 432/435 — PRD ainda pode estar no seed 206 cru).
--
-- ROLLBACK: `UPDATE iam.permissions SET deprecated_at = NULL WHERE resource = ANY(<lista abaixo>)
-- AND action = 'write'` (e o espelho equivalente em `public.permissions`, se existir) — reversível
-- a qualquer momento, porque nenhuma linha foi apagada.

BEGIN;

DO $$
DECLARE
  v_resources TEXT[] := ARRAY[
    'catalog_therapeutic_activities', 'catalog_therapeutic_objectives', 'catalog_therapeutic_segments',
    'funnel', 'interview', 'messaging', 'patient', 'patient_address', 'patient_care_team',
    'patient_chat', 'patient_coverage', 'patient_family', 'patient_identity',
    'patient_services', 'patient_therapeutic_project', 'prescreening', 'recruitment', 'talentum',
    'user_management', 'vacancy', 'worker', 'worker_document'
  ];
  v_n INT;
BEGIN
  -- Guarda dura: `permission_management`, `upload` (critério a — sem create/update no catálogo)
  -- e `patient_clinical` (critério b — checagem LITERAL de `:write` em
  -- therapeuticProjectAccess.ts, achado 20/09/2026) NUNCA podem estar nesta lista. Se algum dia
  -- alguém editar o array acima e incluir um dos três por engano, a migration aborta.
  IF v_resources && ARRAY['permission_management', 'upload', 'patient_clinical']::TEXT[] THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = '[453] permission_management/upload (sem create/update) e patient_clinical (checagem literal de :write) não podem entrar nesta lista';
  END IF;

  IF to_regclass('iam.permissions') IS NOT NULL THEN
    UPDATE iam.permissions
       SET deprecated_at = now()
     WHERE resource = ANY(v_resources)
       AND action = 'write'
       AND deprecated_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[453] iam.permissions: % células :write marcadas deprecated_at agora (das 22 nomeadas)', v_n;
  END IF;

  -- Espelho em `public.*` só se for TABELA física (não a view de compat da 274).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    -- `public.permissions` (seed 206 cru) não tem coluna `deprecated_at` — só existe em
    -- `iam.permissions` (274/281). Nada a fazer aqui; guard mantido por simetria com o molde
    -- da 435/432, caso a coluna seja adicionada lá no futuro.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'permissions' AND column_name = 'deprecated_at'
    ) THEN
      UPDATE public.permissions
         SET deprecated_at = now()
       WHERE resource = ANY(v_resources)
         AND action = 'write'
         AND deprecated_at IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE NOTICE '[453] public.permissions: % células :write marcadas deprecated_at agora', v_n;
    END IF;
  END IF;
END
$$;

COMMIT;
