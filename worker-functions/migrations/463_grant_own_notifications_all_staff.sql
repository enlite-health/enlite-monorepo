-- 463 — `own_notifications:read|update` concedida a TODO grupo de staff ativo (D-07, T408)
--
-- POR QUÊ: D-07 é explícito que `own_notifications:*` nasce DIFERENTE de
-- `patient_conversation:*`/`staff_directory:read` (que nascem com 0 grupos, D285/D329): "nasce
-- concedida a todo staff" — o sino só faz sentido se QUALQUER staff vê a própria notificação, não
-- só quem está no Acesso Master. Esta migration é ADITIVA ao mecanismo de D-07 (não substitui a
-- 462/T132, que cobre o Master explicitamente por D-23 — 463 cobre a distribuição mais ampla).
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
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM
-- iam.permissions WHERE resource = 'own_notifications')`. Nenhuma linha de `iam.permissions` é
-- tocada.

BEGIN;

DO $$
DECLARE
  v_n INT;
BEGIN
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
    RAISE NOTICE '[463] own_notifications concedida a todo grupo ativo: % linhas novas (spec 022, D-07)', v_n;
  END IF;
END
$$;

COMMIT;
