-- 464 — `own_notifications:read|update` concedida a TODO grupo de staff ativo (D-07, T408)
--
-- POR QUÊ: D-07 é explícito que `own_notifications:*` nasce DIFERENTE de
-- `patient_conversation:*`/`staff_directory:read` (que nascem com 0 grupos, D285/D329): "nasce
-- concedida a todo staff" — o sino só faz sentido se QUALQUER staff vê a própria notificação, não
-- só quem está no Acesso Master. Esta migration é ADITIVA ao mecanismo de D-07 (não substitui a
-- 463/T132, que cobre o Master explicitamente por D-23 — 464 cobre a distribuição mais ampla).
--
-- Sem função `iam.grant_*` reaproveitável para "todo grupo" além de
-- `grant_active_permissions_to_master()` (Master-only, não serve aqui) — não existe outra função
-- já chamada por outra migration que faça isto; por isso a regra de decisão de T408 manda
-- ESCREVER a migration de seed (não criar função genérica nova para uma única spec).
--
-- Idempotente: `ON CONFLICT DO NOTHING`, itera `iam.permission_groups WHERE archived_at IS NULL`
-- (mesmo filtro de "grupo ativo" usado pelas funções SECURITY DEFINER da migration 279).
--
-- O QUE NÃO FAZ: não mexe em `patient_conversation:*`/`staff_directory:read` (continuam nascendo
-- com 0 grupos fora do Master, D329); nunca remove grant; nunca concede a grupo arquivado.
--
-- 🔒 Achado ALTO do gate revisao-pr (B4): esta migration roda ANTES do sync do catálogo no boot
-- (`Dockerfile` roda migrations e só DEPOIS `npm start`, que sincroniza `iam.permissions` —
-- `wirePermissionsModule.ts`) — num banco NOVO (CI, stage/prd no primeiro deploy desta spec),
-- `own_notifications` ainda não existe em `iam.permissions` neste ponto: o `CROSS JOIN` acima
-- casava 0 linhas, a migration ficava registrada em `schema_migrations` (D-16, roda UMA vez) e
-- NUNCA voltava a rodar sozinha — diferente do Master (463), que tem uma rede de segurança
-- automática (`iam.grant_active_permissions_to_master()`, todo boot com sync ligado), os OUTROS
-- grupos não têm NENHUM catch-up — ficariam com o sino quebrado (403 em `own_notifications`) até
-- alguém rodar esta migration de novo à mão. Conserto no molde da 435
-- (`435_split_write_grants_create_update.sql:83-94`): semeia as 2 células placeholder em
-- `iam.permissions` (idempotente, `ON CONFLICT (resource, action) DO NOTHING`, mesma forma que o
-- sync gravaria — `PermissionCell.ts`, `RESOURCE_CATEGORY.own_notifications`/`CELL_DESCRIPTION`)
-- ANTES do grant, para que ele NUNCA dependa de o sync já ter rodado.
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM
-- iam.permissions WHERE resource = 'own_notifications')`. As 2 linhas placeholder inseridas aqui
-- podem ficar (célula sem grant não concede nada) — o primeiro boot sincroniza a descrição real
-- por cima, sem perder o `id` (mesmo padrão da 435).

BEGIN;

DO $$
DECLARE
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    -- Seed placeholder das 2 células que só nasceriam no sync de boot — sem isto, o grant abaixo
    -- depende de o sync já ter rodado ANTES desta migration, o que nunca é garantido num banco
    -- novo (migrations rodam antes do boot).
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('own_notifications', 'read',
       '[464 placeholder — sincronizado no boot] Ver as próprias notificações do sino e a contagem de não lidas.',
       'Administração', 'worker-functions', NULL),
      ('own_notifications', 'update',
       '[464 placeholder — sincronizado no boot] Marcar a(s) própria(s) notificação(ões) do sino como lida(s).',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT g.id, p.id
      FROM iam.permission_groups g
      CROSS JOIN iam.permissions p
     WHERE g.archived_at IS NULL
       AND p.resource = 'own_notifications'
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[464] own_notifications concedida a todo grupo ativo: % linhas novas (spec 022, D-07)', v_n;
  END IF;
END
$$;

COMMIT;
