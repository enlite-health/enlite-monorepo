-- 463 — Grant explícito ao Acesso Master das 7 células da spec 022 (D-23, T132)
--
-- POR QUÊ: Gabriel pediu por escrito (citação em tasks.md D-22/D-23): "essa funcionalidade
-- precisa entrar no ABAC ... inserir a autorização direto no grupo MASTER". O catch-up
-- automático da migration 436 (`iam.grant_active_permissions_to_master()`, chamado a cada boot
-- com `PERMISSION_CATALOG_SYNC_ENABLED=true`) JÁ cobriria isto sozinho (medido em
-- `evidencias/b1-matriz-abac.md`: as 4 células de `patient_conversation` já apareceram no Master
-- via auto-grant, sem esta migration) — mas a instrução pede a migration explícita mesmo assim.
-- Esta migration é REDUNDANTE com o catch-up automático quando ele já rodou, e por isso é
-- inofensiva (idempotente, `ON CONFLICT DO NOTHING`, nunca `DELETE`).
--
-- Adiada do B1 para o B4 (tasks.md, nota "Adiada para o B4" de T132): das 7 células, 5
-- (`patient_conversation:read|create|update|delete`, `staff_directory:read`) já existiam no B1;
-- as 2 restantes (`own_notifications:read|update`) só passam a existir no catálogo quando as
-- rotas do sino (T405/T406, Bloco 4) são montadas e o boot sincroniza o catálogo. Rodar esta
-- migration antes disso concederia só 5 e nunca voltaria pelas 2 — migration roda UMA vez,
-- registrada em `schema_migrations` (D-16).
--
-- O QUE NÃO FAZ: não mexe em nenhum outro grupo (D285 intacta para eles); nunca remove grant.
--
-- 🔒 Achado do gate revisao-pr (B4, conserto do B3-r2, item 4 — MESMO motivo da migration 464):
-- "as 2 restantes só passam a existir no catálogo quando o boot sincroniza" (parágrafo acima)
-- descreve exatamente a falha — em um banco NOVO (CI, ambiente recém-criado), esta migration roda
-- ANTES do sync de boot (`Dockerfile` roda migrations e só DEPOIS `npm start`), então
-- `own_notifications` ainda não existe em `iam.permissions` neste ponto e o grant concede só as 5
-- células antigas (`patient_conversation`/`staff_directory`), nunca as 2 novas — a migration roda
-- UMA vez, registrada em `schema_migrations` (D-16), e não volta sozinha. Para o Master
-- especificamente isso é coberto por um mecanismo JÁ EXISTENTE e não desta spec — o catch-up
-- automático de todo boot com `PERMISSION_CATALOG_SYNC_ENABLED=true`
-- (`iam.grant_active_permissions_to_master()`, migration 436) reconcede ao Master qualquer célula
-- nova sempre que o catálogo sincroniza — mas essa rede de segurança não existe para os OUTROS
-- grupos (ver migration 464). Mesmo assim, para o Master também não fazer sentido esperar por um
-- boot seguinte quando esta migration TEM como conceder de uma vez: molde da 435
-- (`435_split_write_grants_create_update.sql:83-94`) — insere as 2 células placeholder em
-- `iam.permissions` (idempotente, `ON CONFLICT (resource, action) DO NOTHING`, mesma forma que o
-- sync gravaria — `PermissionCell.ts`, `RESOURCE_CATEGORY.own_notifications`/`CELL_DESCRIPTION`)
-- ANTES do grant, para que ele NUNCA dependa da ordem migration-antes-do-sync.
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE group_id = 'a0000000-0000-0000-0000-000000000001'
-- AND permission_id IN (SELECT id FROM iam.permissions WHERE resource IN ('patient_conversation',
-- 'staff_directory', 'own_notifications'))`. As 2 linhas placeholder de `iam.permissions` inseridas
-- aqui podem ficar (célula sem grant não concede nada) — o primeiro boot sincroniza a descrição
-- real por cima, sem perder o `id` (mesmo padrão da 435).

BEGIN;

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    -- Seed placeholder das 2 células que só nasceriam no sync de boot (mesma forma/categoria que
    -- `PermissionCell.ts` declara — `RESOURCE_CATEGORY.own_notifications = 'Administração'`) —
    -- sem isto, o grant abaixo depende de o sync já ter rodado ANTES desta migration, o que nunca
    -- é garantido num banco novo (migrations rodam antes do boot).
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('own_notifications', 'read',
       '[463 placeholder — sincronizado no boot] Ver as próprias notificações do sino e a contagem de não lidas.',
       'Administração', 'worker-functions', NULL),
      ('own_notifications', 'update',
       '[463 placeholder — sincronizado no boot] Marcar a(s) própria(s) notificação(ões) do sino como lida(s).',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource IN ('patient_conversation', 'staff_directory', 'own_notifications')
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[463] grant explícito ao Acesso Master: % células novas (spec 022, D-23)', v_n;
  END IF;
END
$$;

COMMIT;
