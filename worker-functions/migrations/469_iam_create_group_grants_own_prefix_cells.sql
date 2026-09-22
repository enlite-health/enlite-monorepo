-- 469 — `iam.create_group` passa a conceder as células `own_*` automaticamente NA CRIAÇÃO
-- (change 022-ux-mencao-e-notificacao, Rodada 4, R4-2, pedido do Gabriel 22/09)
--
-- POR QUÊ: a 468 fecha o PASSADO (catch-up para grupo já existente); sem este lado
-- ESTRUTURAL, o PRÓXIMO grupo criado no painel volta a nascer sem `own_*` e o MESMO 403 de
-- heartbeat (145 DENY/6h medidos em prd) reaparece amanhã, exigindo outra migration de
-- catch-up toda vez. `iam.create_group` (`279_iam_writer_functions.sql`) é o ÚNICO caminho
-- de escrita de grupo novo — a role do app não tem INSERT direto em
-- `iam.permission_groups` (mig 269/274), e todo caminho do código
-- (`PgPermissionGroupRepository.create` → `POST /api/admin/permission-groups`, portão
-- `permission_management:write`) converge nesta função. O INSERT do grant entra NA MESMA
-- função, logo na MESMA transação implícita da criação: uma função SECURITY DEFINER
-- chamada por um único `SELECT iam.create_group(...)` já é atômica — se o grant falhasse,
-- o rollback desfaria os dois juntos; não existe estado intermediário "grupo criado, sem
-- own_*" observável por outra sessão.
--
-- DECISÃO (por que NÃO reusar/estender `iam.grant_active_permissions_to_master`, mig 436):
-- aquela função concede TODA célula ATIVA do catálogo a UM grupo de id FIXO (o Master).
-- Alvo (grupo variável — o recém-criado — vs. id fixo) e conjunto de células (só `own_*`
-- vs. todo o catálogo) são os DOIS diferentes do que R4-2 precisa. Parametrizá-la para
-- servir aos dois casos a tornaria genérica o bastante para violar a garantia auditada por
-- `celulaNovaNaoEntraEmGrupo.test.ts` ("a função da 436 concede SÓ pelo id fixo do Master,
-- sem JOIN com `permission_groups`" — testes da seção D338).
--
-- DECISÃO (por que NÃO extraio uma função nova `iam.grant_own_cells(...)` reaproveitável
-- entre 468 e esta migration): mesma decisão já tomada na 464 (comentário de cabeçalho:
-- "não existe outra função já chamada por outra migration que faça isto; a regra de decisão
-- de T408 manda ESCREVER a migration de seed, não criar função genérica nova para uma única
-- spec"). O filtro (`p.resource LIKE 'own\_%' ESCAPE '\' AND p.deprecated_at IS NULL`) é
-- curto o bastante para duplicar sem risco prático de deriva, e uma função nova só para 2
-- chamadores adicionaria superfície de ACL (mais uma `SECURITY DEFINER` para gatear) sem
-- necessidade — `create_group` já é gateada por `_require_manager`, e a 468 já roda como
-- dono da migration. O teste unit desta rodada
-- (`ownCellsAutoGrantRuleDerivadaDoCatalogo.test.ts`) prova que os DOIS lugares (468 e esta
-- função) usam o MESMO filtro literal — se divergirem, o teste cai.
--
-- O QUE NÃO FAZ: não concede nenhuma célula fora do prefixo `own_`; não altera grupo
-- existente (só o grupo que ESTA chamada está criando — via `v_id`, nunca um id fixo nem
-- um JOIN com `permission_groups`); não muda a assinatura nem os gates de erro de
-- `iam.create_group` (`_require_manager` continua a única porta).
--
-- ROLLBACK: `CREATE OR REPLACE FUNCTION iam.create_group(...)` de volta ao corpo da 279
-- (sem o INSERT de `group_permissions`). Não desfaz grants já concedidos por chamadas
-- feitas enquanto esta versão esteve ativa — mesma lógica "não desfaz o que já fechou o
-- bug" da 467.

BEGIN;

CREATE OR REPLACE FUNCTION iam.create_group(p_tenant_id UUID, p_name TEXT, p_description TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_actor VARCHAR := iam._require_manager(p_tenant_id);
  v_id UUID;
BEGIN
  INSERT INTO iam.permission_groups (tenant_id, name, description, is_system, created_by)
  VALUES (p_tenant_id, p_name, p_description, false, v_actor)
  RETURNING id INTO v_id;

  -- R4-2 (spec 022, Rodada 4, migration 469): mesmo filtro de prefixo da migration 468 —
  -- grupo novo nasce já com as células "própria" (own_*), sem depender de catch-up futuro.
  INSERT INTO iam.group_permissions (group_id, permission_id)
  SELECT v_id, p.id
    FROM iam.permissions p
   WHERE p.resource LIKE 'own\_%' ESCAPE '\'
     AND p.deprecated_at IS NULL
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION iam.create_group(UUID, TEXT, TEXT) IS
  'Cria grupo de permissão (279) e concede automaticamente as células own_* do catálogo '
  '(469, R4-2, D-07 estendido) — mesmo filtro de prefixo da migration 468.';

COMMIT;
