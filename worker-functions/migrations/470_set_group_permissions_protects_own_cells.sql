-- 470 — `iam.set_group_permissions` (279) para de apagar as células `own_*` no REPLACE TOTAL
-- (change 022-ux-mencao-e-notificacao, Rodada 5, R5-1 — achado A5 do gate `revisao-pr` da
-- Rodada 4, decisão do Gabriel 22/09)
--
-- POR QUÊ: `iam.set_group_permissions` grava exatamente o conjunto de células enviado pelo
-- painel — tudo que sobra fora da lista é removido (`DELETE ... WHERE NOT (permission_id =
-- ANY(lista))`). As migrations 464/466/467/468/469 passaram a conceder as células `own_*`
-- (`own_notifications:read/update`, `own_presence:update`) a TODO grupo — de saída, na
-- criação (469) e por catch-up (468) — porque são células sobre o PRÓPRIO usuário (o
-- heartbeat de presença, marcar a própria notificação como lida), não acesso a dado de
-- terceiro. Só que ninguém no painel MARCA essas células na tela de permissões — elas vivem
-- por fora do que o usuário vê e edita. Resultado medido em prd (achado A5, gate da Rodada
-- 4): salvar a matriz de um grupo qualquer, do jeito que o painel sempre salvou (a tela nem
-- mostra `own_*` para marcar), zera as 3 células desse grupo — 111 DENY em 2h quando a
-- presença faltou. O buraco está aberto para TODO grupo, não só os pegos pela 468/469; a
-- primeira gravação de matriz depois desta migration reabre o mesmo incidente.
--
-- DECISÃO (Gabriel, 22/09): a matriz NUNCA remove célula de família `own_*` — protegida
-- direto na função, não na tela. Continua sendo REPLACE TOTAL para todo o resto (a garantia
-- que o painel depende — desmarcar uma célula de verdade tem que continuar revogando);
-- `own_*` é a ÚNICA exceção, porque é a ÚNICA família de célula que não é "acesso a dado de
-- terceiro" — é o usuário agindo sobre o próprio registro (presença, notificação).
--
-- O QUE MUDA (ver corpo abaixo): o bloco de "removidas" ganha
-- `AND NOT (p.resource LIKE 'own\_%' ESCAPE '\')` tanto no INSERT da trilha
-- (`permission_group_changes`, op='remove') quanto no DELETE de `group_permissions` — mesmo
-- filtro de prefixo já usado em 464/466/467/468/469, e por isso não diverge do que decide
-- "o que é own_*" em nenhum dos dois lados. Sem o filtro na trilha, a `own_*` sumiria do
-- DELETE mas ainda registraria um 'remove' fantasma (a célula continua lá, mas o histórico
-- mentiria que foi revogada) — por isso o filtro entra nos DOIS INSERTs/DELETE, não só um.
--
-- ⚠️ CORREÇÃO (23/09, achado 🔴 do gate `revisao-pr`): a definição VIVA de
-- `iam.set_group_permissions` antes desta migration NÃO é a da 279 — é a da **456**
-- (`456_iam_master_group_self_managed.sql`, em main desde 5628c326), que já roda em prd. A
-- primeira versão desta migration copiou o corpo da 279 e, com isso, removeu em silêncio a
-- linha `PERFORM iam._require_master_membership(p_group_id);` que a 456 tinha acrescentado —
-- o guard que impede alguém de fora do Acesso Master reescrever as próprias células do Acesso
-- Master (spec 021, bloco 2). Em prd há 1 pessoa no Super Admin que voltaria a poder fazer
-- isso; o anti-lockout da 451/456 não protege contra essa reintrodução porque ela nunca
-- remove membro, só a checagem. Corrigido: o corpo abaixo parte da 456, com a linha
-- `PERFORM iam._require_master_membership(p_group_id);` mantida logo após
-- `v_actor := iam._require_manager(v_g.tenant_id);`, e SÓ os dois filtros `own_*` descritos
-- acima como diff sobre esse corpo.
--
-- O QUE NÃO MUDA: assinatura (`p_group_id UUID, p_permission_ids UUID[], p_reason TEXT`),
-- retorno (`VOID`), dono, ACL (`CREATE OR REPLACE` preserva GRANT/REVOKE já feitos —
-- esta migration não repete o bloco de GRANT EXECUTE), `SECURITY DEFINER`, `search_path`, os
-- gates (`_require_manager`, `_require_master_membership` da 456, catálogo, anti-lockout) e a
-- semântica REPLACE para qualquer célula fora do prefixo `own_` — o bloco de "adicionadas" é
-- IDÊNTICO ao da 456/279 (se a lista enviada incluir uma `own_*`, o `NOT EXISTS` já barra o
-- 'add' repetido e o `ON CONFLICT DO NOTHING` já barra a linha duplicada — nenhum dos dois
-- precisou de código novo).
--
-- REVERSIBILIDADE PARCIAL (achado 🟡 do gate, registrado — não implementado aqui por decisão
-- do Gabriel): depois desta migration não existe caminho de APLICAÇÃO para revogar uma única
-- célula `own_*` de UM grupo (o REPLACE TOTAL nunca mais a remove, seja qual for a lista
-- enviada). Caminho de exceção hoje: `DELETE FROM iam.group_permissions WHERE group_id =
-- '<id>' AND permission_id = '<id da own_* a revogar>';` direto em prd, registrado como
-- migration manual (ver `docs/funcionalidades/ebrain/...`) — não há função exposta para isso.
--
-- ROLLBACK: `CREATE OR REPLACE FUNCTION iam.set_group_permissions(...)` de volta ao corpo da
-- **456** (com `PERFORM iam._require_master_membership(p_group_id);` e SEM os dois filtros
-- `AND NOT (p.resource LIKE 'own\_%' ESCAPE '\')`). Reabre o achado A5 — não desfaz nenhuma
-- gravação já feita com a proteção ativa (mesma lógica "não desfaz o que já fechou o bug" da
-- 467/469).

BEGIN;

CREATE OR REPLACE FUNCTION iam.set_group_permissions(p_group_id UUID, p_permission_ids UUID[], p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_bad INT;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  PERFORM iam._require_master_membership(p_group_id);

  -- toda célula precisa existir no catálogo e não estar descontinuada
  SELECT count(*) INTO v_bad
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  WHERE NOT EXISTS (SELECT 1 FROM iam.permissions p WHERE p.id = x.id AND p.deprecated_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = format('[iam] %s célula(s) fora do catálogo ou descontinuada(s)', v_bad);
  END IF;

  -- removidas — mig 470: exclui `own_*` (célula sobre o PRÓPRIO usuário, nunca acesso a dado
  -- de terceiro). O REPLACE TOTAL continua valendo para todo o resto do catálogo; só a família
  -- `own_*` fica de fora do DELETE e da trilha 'remove' (sem isso, "remove fantasma" mentiria
  -- que a célula foi revogada quando ela nunca saiu de `group_permissions`).
  INSERT INTO iam.permission_group_changes (group_id, permission_id, op, changed_by, reason)
  SELECT gp.group_id, gp.permission_id, 'remove', v_actor, p_reason
  FROM iam.group_permissions gp
  JOIN iam.permissions p ON p.id = gp.permission_id
  WHERE gp.group_id = p_group_id
    AND NOT (gp.permission_id = ANY (COALESCE(p_permission_ids, ARRAY[]::UUID[])))
    AND NOT (p.resource LIKE 'own\_%' ESCAPE '\');
  DELETE FROM iam.group_permissions gp
  USING iam.permissions p
  WHERE p.id = gp.permission_id
    AND gp.group_id = p_group_id
    AND NOT (gp.permission_id = ANY (COALESCE(p_permission_ids, ARRAY[]::UUID[])))
    AND NOT (p.resource LIKE 'own\_%' ESCAPE '\');

  -- adicionadas — idêntico à 279: se a lista enviada incluir uma `own_*` já concedida
  -- (linha de base da 468/469), o NOT EXISTS barra o 'add' repetido e o ON CONFLICT barra a
  -- linha duplicada em group_permissions — idempotente sem nenhum código extra aqui.
  INSERT INTO iam.permission_group_changes (group_id, permission_id, op, changed_by, reason)
  SELECT p_group_id, x.id, 'add', v_actor, p_reason
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  WHERE NOT EXISTS (SELECT 1 FROM iam.group_permissions gp WHERE gp.group_id = p_group_id AND gp.permission_id = x.id);
  INSERT INTO iam.group_permissions (group_id, permission_id)
  SELECT p_group_id, x.id
  FROM unnest(COALESCE(p_permission_ids, ARRAY[]::UUID[])) AS x(id)
  ON CONFLICT DO NOTHING;

  PERFORM iam._assert_not_last_manager(v_g.tenant_id);
END;
$$;

COMMENT ON FUNCTION iam.set_group_permissions(UUID, UUID[], TEXT) IS
  'REPLACE TOTAL das células do grupo (corpo da 456, com o guard _require_master_membership '
  'da spec 021/bloco 2 preservado), exceto a família own_* — protegida do DELETE e da trilha '
  'remove desde a 470 (R5-1, achado A5 do gate revisao-pr da Rodada 4): são células sobre o '
  'PRÓPRIO usuário, não acesso a dado de terceiro.';

COMMIT;
