/**
 * pedidos-ia-abac.integration.e2e.ts @integration — spec 078, M3b-1.4: `/admin/pedidos-ia` com o engine ABAC LIGADO e staff REAL em grupo
 * (células por SQL). `pedidos_ia:read` abre a tela; `pedidos_ia:decidir` mostra os 3 botões e deixa a decisão passar na API.
 *
 *  leitor  — só `read`: o item aparece no menu, a lista abre, NÃO há botão Aceptar/Negar/Describir, e a API recusa a decisão com 403 (0 eventos).
 *  decisor — `read` + `decidir`: Aceptar -> status "Aceptado" na tela, 1 evento no banco (humano, uid dele).
 *  sem     — staff sem célula: sem item no menu, a URL redireciona, e a API recusa a leitura (403). Controle positivo: o leitor lê (200).
 *
 * ⚠️ Engine ligado e `PERMISSION_CATALOG_SYNC_ENABLED=true` (células de migration 552) — por isso o token `pedidos-ia-abac` entra no `--grep` do
 * job `integration-e2e-group-simulation` do `_frontend-integration.yml`, e NÃO no do `pr-gate.yml`. Escrito sem rodar local (stack do CI).
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, scalar, seedStaffInGroup, tokenFor, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { contarEventos, limparPedidos, seedPedido, ultimoEvento } from '../helpers/pedidos-ia-seed';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const AREA = `ar-abac-${RUN}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-pia-${nome}-${RUN}`, email: `pia.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const LEITOR = mk('leitor');
const DECISOR = mk('decisor');
const SEM = mk('sem');
const GESTOR = mk('gestor'); // permission_management:read+write — abre o painel de acesso (decisão 30/10: pedidos_ia só no Acesso Master)
const ID_ACESSO_MASTER = 'a0000000-0000-0000-0000-000000000001';
const grupos: Record<string, string> = {};
let pedidoLeitor = '';
let pedidoDecisor = '';

const api = (u: MockUser, method: 'GET' | 'POST', path: string) =>
  fetch(`${ABAC_API_URL}${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(u)}`, 'Content-Type': 'application/json' } });

test.describe('pedidos-ia ABAC 078 — read vê, decidir decide, sem célula não entra @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    limparPedidos(scalar, AREA);
    pedidoLeitor = seedPedido(scalar, { assunto: `Leitor ${RUN}`, area: AREA });
    pedidoDecisor = seedPedido(scalar, { assunto: `Decisor ${RUN}`, area: AREA });
    for (const [chave, u] of [['leitor', LEITOR], ['decisor', DECISOR], ['sem', SEM], ['gestor', GESTOR]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Pia078 ${chave} ${RUN}`, country: 'AR' }).groupId;
    }
    grantCell(grupos.leitor, 'pedidos_ia', 'read');
    grantCell(grupos.decisor, 'pedidos_ia', 'read');
    grantCell(grupos.decisor, 'pedidos_ia', 'decidir');
    grantCell(grupos.gestor, 'permission_management', 'read');
    grantCell(grupos.gestor, 'permission_management', 'write');
    // O contrato de acesso tem cache no backend: espera as células chegarem ANTES de abrir a tela.
    await pollAuthz(request, LEITOR, (b) => b?.permissions?.includes('pedidos_ia:read'));
    await pollAuthz(request, DECISOR, (b) => b?.permissions?.includes('pedidos_ia:decidir'));
  });

  test.afterAll(() => {
    limparPedidos(scalar, AREA);
    for (const [chave, u] of [['leitor', LEITOR], ['decisor', DECISOR], ['sem', SEM], ['gestor', GESTOR]] as Array<[string, MockUser]>) {
      cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
    }
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Pia078 % ${RUN}'`);
  });

  test('leitor (só read): item no menu, lista abre, NENHUM botão de decisão e a API recusa a decisão (403, 0 eventos)', async ({ page }) => {
    await loginAs(page, LEITOR);
    const item = page.locator('a[href="/admin/pedidos-ia"]');
    await expect(item.first()).toBeVisible({ timeout: 30_000 });
    await item.first().click();
    await expect(page.getByTestId('pedidos-ia-page')).toBeVisible();
    await escolherNoCombo(page, page.getByTestId('pedidos-filtro-area'), AREA);
    const post = page.getByTestId(`pedido-post-${pedidoLeitor}`);
    await expect(post).toBeVisible();
    await expect(page.getByTestId('pedidos-somente-leitura')).toBeVisible();
    await expect(page.getByTestId('pedido-aceitar')).toHaveCount(0);
    await expect(page.getByTestId('pedido-negar')).toHaveCount(0);
    await expect(page.getByTestId('pedido-descrever')).toHaveCount(0);

    expect((await api(LEITOR, 'GET', '/api/admin/pedidos-ia')).status).toBe(200); // controle positivo: a leitura passa
    expect((await api(LEITOR, 'POST', `/api/admin/pedidos-ia/${pedidoLeitor}/aceitar`)).status).toBe(403);
    expect(contarEventos(scalar, pedidoLeitor)).toBe(0);
  });

  test('decisor (read + decidir): os 3 botões existem e Aceptar muda o status e grava 1 evento do próprio uid', async ({ page }) => {
    await loginAs(page, DECISOR);
    await page.locator('a[href="/admin/pedidos-ia"]').first().click();
    await escolherNoCombo(page, page.getByTestId('pedidos-filtro-area'), AREA);
    const post = page.getByTestId(`pedido-post-${pedidoDecisor}`);
    await expect(post.getByTestId('pedido-aceitar')).toBeVisible();
    await expect(post.getByTestId('pedido-negar')).toBeVisible();
    await expect(post.getByTestId('pedido-descrever')).toBeVisible();
    await post.getByTestId('pedido-aceitar').click();
    await expect(post.getByTestId('pedido-status')).toHaveText('Aceptado', { timeout: 20_000 });
    expect(contarEventos(scalar, pedidoDecisor)).toBe(1);
    expect(ultimoEvento(scalar, pedidoDecisor)).toBe(`aceitar|${DECISOR.uid}|humano`);
  });

  test('sem célula: sem item no menu, a URL redireciona e a API recusa a leitura (403)', async ({ page }) => {
    await loginAs(page, SEM);
    await expect(page.locator('a[href="/admin/pedidos-ia"]')).toHaveCount(0);
    await page.goto('/admin/pedidos-ia');
    await expect(page).not.toHaveURL(/pedidos-ia/, { timeout: 20_000 });
    await expect(page.getByTestId('pedidos-ia-page')).toHaveCount(0);
    expect((await api(SEM, 'GET', '/api/admin/pedidos-ia')).status).toBe(403);
  });

  // ── Decisão do Gabriel (30/10, spec 078): `pedidos_ia:*` só existe no grupo Acesso Master.
  test('painel de acesso: grupo comum NÃO lista pedidos_ia; o Acesso Master lista, somente leitura', async ({ page }) => {
    await loginAs(page, GESTOR);
    await page.goto(`/admin/access/groups/${grupos.leitor}`);
    const secao = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secao.getByTestId('screen-tree')).toBeVisible({ timeout: 30_000 });
    // controle positivo: a grade existe e lista células de outras famílias; só as pedidos_ia somem.
    await expect(secao.locator('[aria-label^="permission_management:"]').first()).toBeVisible();
    await expect(secao.locator('[aria-label^="pedidos_ia:"]')).toHaveCount(0);

    await page.goto(`/admin/access/groups/${ID_ACESSO_MASTER}`);
    const secaoMaster = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secaoMaster.getByTestId('screen-tree')).toBeVisible({ timeout: 30_000 });
    await expect(secaoMaster.locator('[aria-label^="pedidos_ia:decidir"]').first()).toBeVisible();
    await expect(secaoMaster.locator('[aria-label^="pedidos_ia:read"]').first()).toBeVisible();
    // somente leitura: nenhuma caixa marcável para pedidos_ia, mesmo com o painel em edição.
    await expect(secaoMaster.locator('input[type="checkbox"][aria-label^="pedidos_ia:"]')).toHaveCount(0);
  });

  test('API: conceder pedidos_ia:decidir a grupo comum -> 422 master_only_cell e 0 linhas novas em group_permissions', async () => {
    const contar = () => Number(scalar(`SELECT count(*) FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
       WHERE gp.group_id = '${grupos.gestor}' AND p.resource = 'pedidos_ia'`));
    const antes = contar();
    const res = await fetch(`${ABAC_API_URL}/api/admin/permission-groups/${grupos.gestor}/permissions`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenFor(GESTOR)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cellKeys: ['permission_management:read', 'permission_management:write', 'pedidos_ia:decidir'] }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code?: string }).code).toBe('master_only_cell');
    expect(antes).toBe(0);
    expect(contar()).toBe(0);
  });
});
