-- 467 — catch-up de `own_notifications:read|update` para grupos ativos que NASCERAM DEPOIS da
-- migration 464 (change 022-ux-mencao-e-notificacao, Rodada 3, pedido do Gabriel 22/09)
--
-- POR QUÊ (achado medido em prd, 22/09): a 464 já concede `own_notifications:read|update` a
-- "TODO grupo ativo" (`CROSS JOIN iam.permission_groups WHERE archived_at IS NULL`) — mas ela é
-- uma migration, e migration roda UMA VEZ SÓ (`schema_migrations`, D-16). Ela varreu os grupos que
-- existiam NAQUELE momento. Dois grupos criados DEPOIS que a 464 já tinha rodado em prd
-- ("Admisión y Supervisión", "Coordinación Clínica") nunca passaram por aquele `CROSS JOIN` —
-- ficaram com o sino visível (`own_notifications:read`, se algum outro caminho concedeu) mas sem
-- `own_notifications:update`: 6 pessoas veem a notificação e não conseguem marcar como lida
-- (rotas `AdminNotificationController.ts:73` e `:90`). É EXATAMENTE a classe de bug que o
-- comentário da própria 464 já nomeava ("os OUTROS grupos não têm NENHUM catch-up — ficariam com
-- o sino quebrado até alguém rodar esta migration de novo à mão") — só que "de novo à mão" não
-- existe: uma migration idêntica não roda 2x. A saída é uma migration NOVA com o MESMO `CROSS
-- JOIN`, que o runner aplica em todo ambiente onde ainda não rodou (inclusive prd, mesmo já tendo
-- rodado 464/466 antes desses 2 grupos existirem).
--
-- Idempotente: `ON CONFLICT DO NOTHING`, itera `iam.permission_groups WHERE archived_at IS NULL`
-- (mesmo filtro de "grupo ativo" das 279/464/466 — grants das vizinhas, sem função nova). Nunca
-- remove grant; nunca concede a grupo arquivado; não mexe em nenhuma outra célula.
--
-- Mesma cautela de ordem de boot que a 464/466 documentam (migrations rodam ANTES do sync do
-- catálogo — `Dockerfile`): banco onde `own_notifications` ainda não existe em `iam.permissions`
-- neste ponto (nunca deveria acontecer em prd, que já tem 464 aplicada, mas garante idempotência
-- num banco novo/CI que rode 467 antes de 464 nunca — elas são independentes e a ordem alfabética
-- do runner já assegura 464 antes de 467) — mesmo seed placeholder, `ON CONFLICT (resource,
-- action) DO NOTHING`.
--
-- ROLLBACK: nenhum — esta migration só GRANT (nunca REVOKE), e as linhas de `group_permissions`
-- que ela cria são indistinguíveis das que a 464 já teria criado se tivesse rodado depois. Reverter
-- reabriria o mesmo bug que ela fecha.

BEGIN;

DO $$
DECLARE
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('own_notifications', 'read',
       '[467 placeholder — sincronizado no boot] Ver as próprias notificações do sino e a contagem de não lidas.',
       'Administração', 'worker-functions', NULL),
      ('own_notifications', 'update',
       '[467 placeholder — sincronizado no boot] Marcar a(s) própria(s) notificação(ões) do sino como lida(s).',
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
    RAISE NOTICE '[467] own_notifications catch-up para grupo ativo criado após a 464: % linhas novas (spec 022, Rodada 3)', v_n;
  END IF;
END
$$;

COMMIT;
