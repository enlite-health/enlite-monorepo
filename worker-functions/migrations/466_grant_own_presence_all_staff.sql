-- 466 — `own_presence:update` concedida a TODO grupo de staff ativo (mesma regra de D-07 para
-- `own_notifications`, change 022-ux-mencao-e-notificacao Rodada 2/R2-B).
--
-- POR QUÊ: o heartbeat de presença (`POST /api/admin/me/presence`) só grava o `last_seen_at` do
-- PRÓPRIO uid autenticado (nunca de outro) — é a mesma classe de célula "own_*" que
-- `own_notifications` (D-07): nasce concedida a TODO staff, não some 0 grupos como
-- `patient_conversation`/`staff_directory` (D285/D329), porque o sino/a presença só fazem
-- sentido se QUALQUER staff autenticado consegue operar o PRÓPRIO estado.
--
-- Idempotente: `ON CONFLICT DO NOTHING`, itera `iam.permission_groups WHERE archived_at IS NULL`
-- (mesmo filtro de "grupo ativo" da 279/464). Nunca remove grant; nunca concede a grupo arquivado.
--
-- Mesmo achado da 463/464 (gate revisao-pr, B4): migrations rodam ANTES do sync do catálogo no
-- boot (`Dockerfile`: migrations primeiro, `npm start` sincroniza `iam.permissions` depois) — num
-- banco NOVO (CI, primeiro deploy desta spec em stage/prd), `own_presence` ainda não existe em
-- `iam.permissions` neste ponto e um `CROSS JOIN` cru casaria 0 linhas, a migration ficaria
-- registrada em `schema_migrations` (D-16, roda UMA vez) e nunca voltaria sozinha. Mesmo conserto
-- da 464: semear a célula placeholder em `iam.permissions` (idempotente, `ON CONFLICT (resource,
-- action) DO NOTHING`) ANTES do grant, para que ele NUNCA dependa de o sync já ter rodado.
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM
-- iam.permissions WHERE resource = 'own_presence')`. A linha placeholder inserida aqui pode ficar
-- (célula sem grant não concede nada) — o primeiro boot sincroniza a descrição real por cima, sem
-- perder o `id` (mesmo padrão da 435/463/464).

BEGIN;

DO $$
DECLARE
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('own_presence', 'update',
       '[466 placeholder — sincronizado no boot] Marcar a PRÓPRIA presença como ativa (heartbeat do painel admin).',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT g.id, p.id
      FROM iam.permission_groups g
      CROSS JOIN iam.permissions p
     WHERE g.archived_at IS NULL
       AND p.resource = 'own_presence'
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[466] own_presence concedida a todo grupo ativo: % linhas novas (spec 022 R2)', v_n;
  END IF;
END
$$;

COMMIT;
