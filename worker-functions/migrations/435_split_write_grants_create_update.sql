-- 435 — conversão de grants `<recurso>:write` → `<recurso>:create` + `<recurso>:update` (PR-8b, ADR-2/SUP-30)
--
-- Número: o desenho original (data-model.md §433) colidiu com a 433/434 já usadas pela spec 019
-- (Localizaciones, em produção) — D335 (14/09) reservou 435 para esta migration.
--
-- POR QUÊ (contracts/permissions-split.md): 19 recursos com `<recurso>:write` LITERAL na rota
-- (`git grep -n "perm\.require([^)]*'write'" -- worker-functions/src | grep -v test` menos
-- `permission_management`) mais 4 recursos declarados por VARIÁVEL (projeto terapêutico e os 3
-- catálogos) — 23 no total — splitam em `create`/`update`. `permission_management` FICA `write`
-- (é a única rota que continua sob ela, linha 11 do contrato) — nunca entra na lista abaixo.
--
-- ORDEM (⚠️ diferente do molde de 431/430): as outras migrations de célula-só-de-código (427,
-- 430, 431) não semeiam `iam.permissions` — a linha nasce no primeiro boot depois do deploy,
-- via `SyncPermissionCatalogUseCase`/`cellsForaDeRota` (design 1b). Esta migration PRECISA que as
-- 46 linhas `create`/`update` já existam no catálogo no MOMENTO em que roda, porque o passo 2
-- (conversão de grants) faz JOIN com elas — e migration roda ANTES do deploy do código novo, não
-- depois. Por isso o passo 1 SEMEIA as 46 linhas diretamente (INSERT ... ON CONFLICT DO NOTHING),
-- com descrição PLACEHOLDER: o primeiro boot do código desta mesma PR sincroniza a descrição real
-- (`iam.sync_permission_cell`/`COALESCE(EXCLUDED.description, ...)` — 281) por cima, sem perder
-- nada — só a categoria/descrição mudam, nunca o `id` (as `group_permissions` já apontam pra ele).
--
-- O QUE FAZ:
--   1. Semeia as 46 células `create`/`update` (23 recursos × 2) em `iam.permissions` (e em
--      `public.permissions`, se essa tabela física existir — PRD ainda no seed 206 cru, mesmo
--      `IF EXISTS`/`to_regclass` do molde da 432).
--   2. Para cada grupo com `<recurso>:write` de um dos 23 recursos, INSERE (nunca substitui)
--      `<recurso>:create` e `<recurso>:update` em `group_permissions`/`iam.group_permissions` —
--      `ON CONFLICT DO NOTHING`, idempotente. A linha `write` NÃO É REMOVIDA (contrato: "as
--      linhas write convertidas ficam até a remoção do alias", SUP-31) — as rotas ainda pedem
--      `write` nesta rodada (A1), então remover a linha write agora tiraria acesso de verdade.
--   3. `permission_management` nunca entra — nem no seed do passo 1, nem no JOIN do passo 2.
--
-- INVARIANTE (medido pelo teste e2e desta task): NINGUÉM ganha nem perde acesso EFETIVO. Rodar
-- 2× não muda nada na 2ª (idempotência) — os `ON CONFLICT DO NOTHING` dos dois passos garantem.
--
-- ROLLBACK: `DELETE FROM group_permissions WHERE permission_id IN (SELECT id FROM permissions
-- WHERE action IN ('create','update') AND resource = ANY(<lista dos 23>))` desfaz o passo 2;
-- as linhas do catálogo (passo 1) podem ficar (célula sem grant não concede nada) ou levar
-- `deprecated_at = now()` se o rollback for definitivo.

BEGIN;

DO $$
DECLARE
  v_resources TEXT[] := ARRAY[
    'patient', 'patient_address', 'patient_chat', 'patient_identity', 'patient_clinical',
    'patient_care_team', 'patient_family', 'patient_coverage', 'patient_services',
    'user_management', 'vacancy', 'funnel', 'talentum', 'prescreening', 'interview',
    'messaging', 'recruitment', 'worker', 'worker_document', 'patient_therapeutic_project',
    'catalog_therapeutic_objectives', 'catalog_therapeutic_activities', 'catalog_therapeutic_segments'
  ];
  v_categories JSONB := '{
    "patient": "Pacientes", "patient_address": "Pacientes", "patient_chat": "Pacientes",
    "patient_identity": "Pacientes", "patient_clinical": "Pacientes", "patient_care_team": "Pacientes",
    "patient_family": "Pacientes", "patient_coverage": "Pacientes", "patient_services": "Pacientes",
    "patient_therapeutic_project": "Pacientes", "catalog_therapeutic_objectives": "Pacientes",
    "catalog_therapeutic_activities": "Pacientes", "catalog_therapeutic_segments": "Pacientes",
    "user_management": "Administração", "vacancy": "Vagas e Funil", "funnel": "Vagas e Funil",
    "talentum": "Recrutamento", "prescreening": "Recrutamento", "interview": "Vagas e Funil",
    "messaging": "Comunicação", "recruitment": "Recrutamento", "worker": "Trabalhadores",
    "worker_document": "Trabalhadores"
  }'::JSONB;
  v_resource TEXT;
  v_grants_before INT;
  v_grants_after  INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    -- 1. Semear as 46 células (idempotente por recurso/ação via UNIQUE(resource,action) da 206)
    --    + a linha `write` dos mesmos 23 recursos (achado da rodada A2, 15/09): até aqui
    --    `<recurso>:write` só entrava no catálogo pelo SYNC de boot, porque a ROTA declarava
    --    `write` literal — e era exatamente essa varredura que alimentava `iam.permissions`
    --    (design 1b, nenhuma migration anterior fazia INSERT dela). A partir do PR-8b 8b.4 a
    --    rota nunca mais declara `write` para estes 23 recursos, então um boot NOVO (banco
    --    vazio: CI, ambiente recém-criado) não semeia `write` nunca mais — o teste e2e
    --    `permission-split-grants-migration.e2e.test.ts` (A1, gWriteMaisDelete/gSoWrite) e o
    --    inventário de outras 21 suítes que concedem `<recurso>:write` de setup quebraram
    --    exatamente assim, medido rodando a suíte inteira contra um container reconstruído do
    --    zero. Em stage/prod a linha `write` já existe (o código ANTIGO, ainda no ar quando esta
    --    migration roda — "migration ANTES do deploy" no cabeçalho — já sincronizou; ver
    --    contracts/permissions-split.md), então este INSERT é NO-OP lá (ON CONFLICT DO NOTHING).
    --    Só um banco NOVO, sem histórico de boot pré-A2, precisa dele.
    FOREACH v_resource IN ARRAY v_resources LOOP
      INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
      VALUES
        (v_resource, 'write',
         format('[435 — alias de transição SUP-31] %s:write legado; nenhuma rota declara mais — remoção prevista em 8b.11.', v_resource),
         v_categories ->> v_resource, 'worker-functions', NULL),
        (v_resource, 'create',
         format('[435 placeholder — sincronizado no boot] Criar %s.', v_resource),
         v_categories ->> v_resource, 'worker-functions', NULL),
        (v_resource, 'update',
         format('[435 placeholder — sincronizado no boot] Editar %s existente.', v_resource),
         v_categories ->> v_resource, 'worker-functions', NULL)
      ON CONFLICT (resource, action) DO NOTHING;
    END LOOP;

    -- 2. Converter grants: quem tem `<recurso>:write` de um dos 23 ganha `create`+`update` do
    --    MESMO recurso, sem perder o `write` (SUP-31). `permission_management` fora da lista —
    --    nunca entra aqui.
    SELECT count(*) INTO v_grants_before FROM iam.group_permissions;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT gp.group_id, pn.id
      FROM iam.group_permissions gp
      JOIN iam.permissions po ON po.id = gp.permission_id AND po.action = 'write' AND po.resource = ANY(v_resources)
      JOIN iam.permissions pn ON pn.resource = po.resource AND pn.action IN ('create', 'update')
    ON CONFLICT DO NOTHING;

    SELECT count(*) INTO v_grants_after FROM iam.group_permissions;
    RAISE NOTICE '[435] iam.group_permissions: % antes, % depois (diferença = grants create/update inseridos)', v_grants_before, v_grants_after;
  END IF;

  -- Espelho em `public.*` só se for TABELA física (PRD, seed 206 cru; a view de compat da 274
  -- não aceita INSERT) — mesmo guard do molde da 432.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    FOREACH v_resource IN ARRAY v_resources LOOP
      INSERT INTO public.permissions (resource, action, description, category)
      VALUES
        (v_resource, 'create', format('[435 placeholder — sincronizado no boot] Criar %s.', v_resource), v_categories ->> v_resource),
        (v_resource, 'update', format('[435 placeholder — sincronizado no boot] Editar %s existente.', v_resource), v_categories ->> v_resource)
      ON CONFLICT (resource, action) DO NOTHING;
    END LOOP;

    SELECT count(*) INTO v_grants_before FROM public.group_permissions;

    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT gp.group_id, pn.id
      FROM public.group_permissions gp
      JOIN public.permissions po ON po.id = gp.permission_id AND po.action = 'write' AND po.resource = ANY(v_resources)
      JOIN public.permissions pn ON pn.resource = po.resource AND pn.action IN ('create', 'update')
    ON CONFLICT DO NOTHING;

    SELECT count(*) INTO v_grants_after FROM public.group_permissions;
    RAISE NOTICE '[435] public.group_permissions: % antes, % depois', v_grants_before, v_grants_after;
  END IF;
END
$$;

COMMIT;
