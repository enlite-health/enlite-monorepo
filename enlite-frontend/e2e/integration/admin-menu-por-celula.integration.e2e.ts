/**
 * admin-menu-por-celula.integration.e2e.ts @integration
 *
 * O bug que o Gabriel viu na stage (07/09/2026): conta num grupo com UMA célula via TODOS os
 * itens de topo do menu lateral (Gestión a la Vista, Usuarios, Vacantes, Prestadores, Mapa,
 * Reclutamiento). A rota negava — dado não vazou — mas o menu mentia. Regra (D286): o item só
 * existe para quem tem alguma célula da tela que ele abre.
 *
 * Prova contra o stack REAL — API com o engine LIGADO, Postgres real, `/v1/me/authz` real. Nada
 * de `page.route` na API: só o Authorization é trocado por `mock_*` (USE_MOCK_AUTH). O que se
 * afirma é o que uma pessoa VÊ e CLICA: o link está ou não está no `<nav>`, o clique leva à
 * tela, a rota que alimenta a tela responde 200 ou 403. Foto de cada estado.
 *
 * Stack: ver o cabeçalho de `admin-access-cells-visual.integration.e2e.ts`. Este spec lê a API e
 * o banco de `ABAC_API_URL` / `ABAC_TEST_DB_URL` (default 8089/5439) — sobe o seu com
 * `docker compose -p <sessão>` e aponte as variáveis.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  cleanupStaffAndGroup,
  grantCell,
  loginAs,
  meAuthz,
  pollAuthz,
  revokeCell,
  seedStaffInGroup,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const STAFF: MockUser = { uid: `e2e-menu-${RUN_ID}`, email: `e2e-menu-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
let groupId = '';

/** Os itens da seção Administración, pelo texto que a pessoa lê (es-AR, idioma do painel). */
const ADMIN = ['Etiquetas', 'Duplicados', 'Mensajes por etapa', 'Plantillas', 'Roles de grupos', 'Invitación a presentación', 'Postulaciones bloqueadas', 'Accesos y permisos'] as const;

const nav = (page: Page) => page.getByRole('navigation').first();
const link = (page: Page, nome: string) => nav(page).getByRole('link', { name: nome, exact: true });

async function menuVisivel(page: Page): Promise<string[]> {
  const nomes = await nav(page).getByRole('link').allInnerTexts();
  return nomes.map((n) => n.trim()).filter(Boolean);
}

/**
 * Foto do estado — `toHaveScreenshot` compara com a baseline darwin versionada em
 * `*-snapshots/` (como os demais specs @integration) e o PNG em `e2e/__screenshots__/` fica no
 * repo para quem revisa VER. O rodapé do menu mostra o nome da conta, que carrega o RUN_ID:
 * mascarado, senão a referência muda a cada corrida.
 */
async function foto(page: Page, nome: string): Promise<void> {
  const mascara = [page.getByText(`E2E ${STAFF.uid}`)];
  await expect(page).toHaveScreenshot(`${nome}.png`, { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.002, mask: mascara });
  await page.screenshot({ path: `e2e/__screenshots__/menu-por-celula-${nome}.png`, fullPage: true, animations: 'disabled', mask: mascara });
}

/** O item que existe FUNCIONA: clique humano, a URL muda, a rota que alimenta a tela responde 200, o título aparece. */
async function abreDoMenu(page: Page, nome: string, rota: string, api: string, fotoNome: string): Promise<void> {
  const resposta = page.waitForResponse((r) => r.url().includes(api) && r.request().method() === 'GET');
  await link(page, nome).click();
  await expect(page).toHaveURL(new RegExp(`${rota}$`));
  expect((await resposta).status()).toBe(200);
  await expect(page.getByRole('heading', { name: nome, exact: true })).toBeVisible({ timeout: 15_000 });
  await foto(page, fotoNome);
}

test.describe('Menu lateral por célula (D286) — o item só existe para quem tem célula da tela @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);

  test.beforeAll(() => {
    ({ groupId } = seedStaffInGroup({ uid: STAFF.uid, email: STAFF.email, groupName: `E2E menu ${RUN_ID}`, country: 'AR' }));
    // O cenário do Gabriel: UMA célula só — a lista de pacientes.
    grantCell(groupId, 'patient', 'read');
  });

  test.afterAll(() => cleanupStaffAndGroup(STAFF.uid, groupId));

  test('0. pré-condição: o contrato real diz enforcement=on e exatamente uma célula', async ({ request }) => {
    const { status, body } = await meAuthz(request, STAFF);
    expect(status).toBe(200);
    expect(body.enforcement, 'a API precisa estar com PERMISSION_ENGINE_ENABLED=true — sem isso o menu não gateia nada (freio D268)').toBe('on');
    expect(body.permissions).toEqual(['patient:read']);
    expect(body.countries).toEqual(['AR']);
  });

  test('1. com só `patient:read`: o menu mostra Pacientes (e o que essa célula abre) e NENHUM dos outros itens de topo', async ({ page }) => {
    await loginAs(page, STAFF);
    // `/admin` (Usuarios) é onde o login cai — sem célula, a rota nega e a tela mostra erro; o
    // que importa aqui é o MENU. `patient:read` também abre "Roles de grupos" (D269); é bloco de
    // Gestión a la Vista, mas abrir essa tela é `dashboard:read` — sem ela, o item não aparece.
    // API Docs é staff-only no back (sem célula na rota) e por isso fica.
    await expect(link(page, 'Pacientes')).toBeVisible({ timeout: 15_000 });

    const visiveis = await menuVisivel(page);
    console.log(`[prova] menu com só patient:read: ${JSON.stringify(visiveis)}`);
    for (const nome of ['Gestión a la Vista', 'Usuarios', 'Vacantes', 'Prestadores', 'Mapa', 'Reclutamiento']) {
      await expect(link(page, nome), `"${nome}" apareceu sem célula`).toHaveCount(0);
    }
    for (const nome of ADMIN.filter((n) => n !== 'Roles de grupos')) {
      await expect(link(page, nome), `"${nome}" apareceu sem célula`).toHaveCount(0);
    }
    await expect(link(page, 'Roles de grupos')).toBeVisible();
    await expect(link(page, 'API Docs')).toBeVisible();
    await foto(page, '1-so-patient-read');

    await abreDoMenu(page, 'Pacientes', '/admin/patients', '/api/admin/patients', '1b-pacientes-abre');
  });

  test('2. o que o Gabriel chamou de correto continua: digitar a URL de Prestadores sem célula → a rota nega (403) e o menu segue sem o item', async ({ page }) => {
    await loginAs(page, STAFF);
    const workers = page.waitForResponse((r) => r.url().includes('/api/admin/workers') && r.request().method() === 'GET');
    await page.goto('/admin/workers');
    expect((await workers).status()).toBe(403);
    await expect(link(page, 'Pacientes')).toBeVisible({ timeout: 15_000 });
    await expect(link(page, 'Prestadores')).toHaveCount(0);
    await foto(page, '2-url-direta-prestadores-negada');
  });

  test('3. o grupo ganha `worker:read` → Prestadores (e Etiquetas) passam a existir; o clique abre a lista com 200', async ({ page, request }) => {
    grantCell(groupId, 'worker', 'read');
    const after = await pollAuthz(request, STAFF, (b) => Array.isArray(b?.permissions) && b.permissions.includes('worker:read'));
    console.log(`[prova] worker:read refletiu em /v1/me/authz em ${after.elapsedMs}ms`);
    expect(after.body.permissions.sort()).toEqual(['patient:read', 'worker:read']);

    await loginAs(page, STAFF);
    await expect(link(page, 'Prestadores')).toBeVisible({ timeout: 15_000 });
    await expect(link(page, 'Etiquetas')).toBeVisible();
    // O que continua sem célula continua fora.
    for (const nome of ['Gestión a la Vista', 'Usuarios', 'Vacantes', 'Mapa', 'Reclutamiento', 'Duplicados', 'Accesos y permisos']) {
      await expect(link(page, nome)).toHaveCount(0);
    }
    const visiveis = await menuVisivel(page);
    console.log(`[prova] menu com patient:read + worker:read: ${JSON.stringify(visiveis)}`);
    await foto(page, '3-ganhou-worker-read');

    await abreDoMenu(page, 'Prestadores', '/admin/workers', '/api/admin/workers', '3b-prestadores-abre');
  });

  test('4. a célula é revogada → o item some de novo (o menu segue o contrato, nos dois sentidos)', async ({ page, request }) => {
    revokeCell(groupId, 'worker', 'read');
    const after = await pollAuthz(request, STAFF, (b) => Array.isArray(b?.permissions) && !b.permissions.includes('worker:read'));
    console.log(`[prova] revogação refletiu em ${after.elapsedMs}ms`);
    expect(after.body.permissions).toEqual(['patient:read']);

    await loginAs(page, STAFF);
    await expect(link(page, 'Pacientes')).toBeVisible({ timeout: 15_000 });
    await expect(link(page, 'Prestadores')).toHaveCount(0);
    await expect(link(page, 'Etiquetas')).toHaveCount(0);
    await foto(page, '4-revogado');
  });
});
