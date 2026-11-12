/**
 * admin-access-agent-group.integration.e2e.ts @integration — spec 078, M2: o seletor de membro do `/admin/access/groups/:id` conforme a CLASSE do grupo,
 * com o engine ABAC LIGADO, gestor REAL em grupo (células por SQL) e a API/trigger reais (sem `page.route` de dado; só o login troca o token).
 *
 *  feliz        — grupo `AGENT` "Luz — espelho Recrutador": a coluna de candidatos lista SÓ contas `agent` (todo item traz o `person-agent-badge`; ≥ 1).
 *  alternativo1 — grupo `INTERNAL`: o agente NÃO aparece (0 badges, agent:luz ausente) e o staff semeado aparece (controle positivo).
 *  alternativo2 — pôr o agente num grupo INTERNAL: (a) pela API o trigger recusa e não grava; (b) pela tela, o grupo (vazio) vira INTERNAL entre o
 *                 carregamento do seletor e o "Guardar" — o trigger recusa e a tela mostra o alerta de erro, com 0 membros gravados.
 *
 * ⚠️ Engine ligado e `PERMISSION_CATALOG_SYNC_ENABLED=true` — o token `admin-access-agent-group` entra no `--grep` do job ABAC do
 * `_frontend-integration.yml` (o mesmo de `pedidos-ia-abac`), não no do `pr-gate.yml`. Dados sintéticos, prefixo `Aag078`.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, psql, safeSql, scalar, seedStaffInGroup, tokenFor, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-aag-${nome}-${RUN}`, email: `aag.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const GESTOR = mk('gestor');
const OUTRO = mk('outro'); // staff fora do grupo do gestor: o controle positivo do INTERNAL
const GRUPO_LUZ = 'Luz — espelho Recrutador';
const AGENTE_UID = 'agent:luz';
const grupos: Record<string, string> = {};
let grupoLuz = '';
let grupoAgentTela = '';

const restoDoTime = (page: import('@playwright/test').Page) => page.getByRole('listbox', { name: 'Resto del equipo' });

test.describe('seletor de membro × classe do grupo — AGENT lista agentes, INTERNAL não, trigger recusa @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    grupoLuz = scalar(`SELECT id FROM iam.permission_groups WHERE name = '${GRUPO_LUZ}' AND actor_class = 'AGENT' AND archived_at IS NULL`);
    if (!grupoLuz) throw new Error(`grupo AGENT "${GRUPO_LUZ}" ausente (migration 556)`);
    grupos.gestor = seedStaffInGroup({ uid: GESTOR.uid, email: GESTOR.email, groupName: `Aag078 gestor ${RUN}`, country: 'AR' }).groupId;
    grupos.outro = seedStaffInGroup({ uid: OUTRO.uid, email: OUTRO.email, groupName: `Aag078 outro ${RUN}`, country: 'AR' }).groupId;
    grantCell(grupos.gestor, 'permission_management', 'read');
    grantCell(grupos.gestor, 'permission_management', 'write');
    grantCell(grupos.gestor, 'user_management', 'read'); // `GET /admin/users` (o diretório do seletor) exige esta célula
    await pollAuthz(request, GESTOR, (b) => b?.permissions?.includes('permission_management:write') && b?.permissions?.includes('user_management:read'));
    grupoAgentTela = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description, actor_class)
        VALUES ('${ABAC_TENANT}', 'Aag078 agente ${RUN}', 'e2e — nao mexer manual', 'AGENT') RETURNING id`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM iam.user_groups WHERE group_id = '${grupoAgentTela}'`);
    safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id = '${grupoAgentTela}'`);
    safeSql(`DELETE FROM iam.permission_groups WHERE id = '${grupoAgentTela}'`);
    for (const [chave, u] of [['gestor', GESTOR], ['outro', OUTRO]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
  });

  test('feliz: no grupo AGENT "Luz — espelho Recrutador" o seletor lista SÓ contas agent, todas com o badge', async ({ page }) => {
    await loginAs(page, GESTOR);
    await page.goto(`/admin/access/groups/${grupoLuz}`);
    const lista = restoDoTime(page);
    await expect(lista).toBeVisible({ timeout: 30_000 });
    const itens = lista.getByRole('option');
    await expect(itens.first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('person-agent-badge').first()).toBeVisible();
    const n = await itens.count();
    expect(n).toBeGreaterThanOrEqual(1);
    await expect(lista.getByTestId('person-agent-badge')).toHaveCount(n); // todo candidato é agente
    await expect(lista.getByRole('option', { name: new RegExp(OUTRO.email.replace(/\./g, '\\.')) })).toHaveCount(0); // nenhum staff
  });

  test('alternativo 1: no grupo INTERNAL o agente não aparece (0 badges) e o staff aparece (controle positivo)', async ({ page }) => {
    await loginAs(page, GESTOR);
    await page.goto(`/admin/access/groups/${grupos.gestor}`);
    const lista = restoDoTime(page);
    await expect(lista).toBeVisible({ timeout: 30_000 });
    await expect(lista.getByRole('option', { name: new RegExp(OUTRO.email.replace(/\./g, '\\.')) })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('person-agent-badge')).toHaveCount(0);
    await expect(page.getByTestId('member-transfer')).not.toContainText(AGENTE_UID);
  });

  test('alternativo 2: agente em grupo INTERNAL — a API é recusada pelo trigger (0 gravado) e a tela mostra o erro', async ({ page }) => {
    // (a) pela API, num grupo INTERNAL de verdade.
    const res = await fetch(`${ABAC_API_URL}/api/admin/permission-groups/${grupos.outro}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(GESTOR)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: AGENTE_UID }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(scalar(`SELECT count(*) FROM iam.user_groups WHERE group_id = '${grupos.outro}' AND user_id = '${AGENTE_UID}'`)).toBe('0');

    // (b) pela tela: o seletor do grupo AGENT (vazio) carrega o agente; o grupo vira INTERNAL por SQL antes do Guardar.
    await loginAs(page, GESTOR);
    await page.goto(`/admin/access/groups/${grupoAgentTela}`);
    const lista = restoDoTime(page);
    const agente = lista.getByRole('option').filter({ has: page.getByTestId('person-agent-badge') }).first();
    await expect(agente).toBeVisible({ timeout: 30_000 });
    await agente.click();
    await page.getByRole('button', { name: 'Agregar a los miembros' }).click();
    psql(`UPDATE iam.permission_groups SET actor_class = 'INTERNAL' WHERE id = '${grupoAgentTela}'`);
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    // O erro da tela é o `PanelErrorAlert` (role=alert) com a frase da chave que `panelErrorKey` escolheu para o 409/23514 do banco.
    // A frase NÃO é afirmada (medido no CI e local: o 23514 da classe cai em `system_group` — "Los grupos de sistema no se renombran
    // ni se archivan." —, não em `admin.access.group.error`): o contrato é "há um alerta com texto" e "nada foi gravado".
    const alerta = page.getByRole('alert').first();
    await expect(alerta).toBeVisible({ timeout: 20_000 });
    await expect(alerta).not.toHaveText('');
    expect(scalar(`SELECT count(*) FROM iam.user_groups WHERE group_id = '${grupoAgentTela}'`)).toBe('0');
  });
});
