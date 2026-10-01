-- 468 — catch-up GENÉRICO de TODA célula "own_*" para grupo ativo que ficou de fora
-- (change 022-ux-mencao-e-notificacao, Rodada 4, R4-1, pedido do Gabriel 22/09)
--
-- POR QUÊ (achado medido em prd, 22/09): 145 DENY de `own_presence:update` em 6h. Três grupos
-- criados HOJE (Coordinación Clínica, Admisión y Supervisión, Finanzas) nasceram sem NENHUMA
-- célula `own_*` — nem `own_notifications`, nem `own_presence`. O heartbeat
-- (`POST /api/admin/me/presence`) leva 403 a cada minuto e a bolinha de presença nunca fica
-- verde. A 467 já fechou um gap IDÊNTICO, mas nomeando um único resource
-- (`own_notifications`) — deixou `own_presence` de fora, e qualquer `own_*` futura teria o
-- MESMO buraco de novo, exigindo outra migration de catch-up a cada célula nova.
--
-- Esta migration generaliza o critério: em vez de nomear cada resource `own_*` (464/466/467
-- fazem isso, um resource por vez), o `CROSS JOIN` filtra por PREFIXO
-- (`p.resource LIKE 'own\_%' ESCAPE '\'`) — cobre `own_notifications`, `own_presence` e
-- qualquer `own_*` que já exista em `iam.permissions` quando esta migration rodar, sem
-- depender de uma migration nova por célula. Não é hardcode de lista: é o PREFIXO que decide.
--
-- Idempotente: `ON CONFLICT DO NOTHING`, itera `iam.permission_groups WHERE archived_at IS
-- NULL` (mesmo filtro de "grupo ativo" das 279/436/464/466/467). Nunca remove grant; nunca
-- concede a grupo arquivado; não mexe em nenhuma célula fora do prefixo `own_`.
--
-- Companion: R4-2 (migration 469) fecha o lado estrutural — `iam.create_group` passa a
-- conceder as células `own_*` já NA CRIAÇÃO, com o MESMO filtro de prefixo. Esta migration
-- (468) só cobre o PASSADO (grupo já existente antes dela rodar); a 469 cobre o FUTURO (grupo
-- criado a partir de agora). Sem a 469, o mesmo bug reabriria no próximo grupo criado no
-- painel — por isso as duas entram no mesmo PR (decisão do Gabriel, 22/09).
--
-- Mesma cautela de ordem de boot que 464/466/467 documentam (migrations rodam ANTES do sync
-- do catálogo — `Dockerfile`): num banco onde `own_*` ainda não existe em `iam.permissions`
-- neste ponto, o `CROSS JOIN` casa 0 linhas sem erro (não é o caso normal — 464/466/467 têm
-- número menor e já rodaram antes desta, seedando os placeholders; o runner aplica por
-- PREFIXO NUMÉRICO, nunca por nome).
--
-- ROLLBACK: `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM
-- iam.permissions WHERE resource LIKE 'own\_%' ESCAPE '\')` — reabriria o bug medido em prd.

BEGIN;

DO $$
DECLARE
  v_n INT;
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT g.id, p.id
      FROM iam.permission_groups g
      CROSS JOIN iam.permissions p
     WHERE g.archived_at IS NULL
       AND p.resource LIKE 'own\_%' ESCAPE '\'
       AND p.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[468] catch-up genérico own_* (prefixo) para todo grupo ativo: % linhas novas (spec 022, Rodada 4)', v_n;
  END IF;
END
$$;

COMMIT;
