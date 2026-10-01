/**
 * Spec 030 (F1, T016) — a tela do catálogo de SEGMENTOS (Ana Care), exercitada por um HUMANO contra o
 * stack REAL (frontend + API com o engine ABAC LIGADO + Postgres). Zero mock de dado: o único
 * `page.route` é o do `loginAs` (troca o Authorization por `mock_*`, USE_MOCK_AUTH — o molde de
 * `admin-menu-por-celula`); a REQUEST segue para a API real e a RESPOSTA é a real.
 * Régua humana (memória `e2e-humano-nao-e-fill`): click + `toBeFocused` + `keyboard.type` + valor lido da TELA.
 *
 * O que se prova:
 *   1. feliz: menu "Segmentos (Ana Care)" → a tela lê as 13 linhas semeadas (migration 495) na ordem do
 *      banco → "Nueva opción", digita → salva → a linha está na tela E no banco → desativa → "Inactiva";
 *   2. alt 1: o mesmo rótulo de um segmento do seed, com OUTRA caixa e espaços → 409, a frase es-AR na
 *      tela, o banco com 1 linha só;
 *   3. alt 2: conta SEM `catalog_therapeutic_segments:read` (engine ligado): sem item no menu, a rota
 *      redireciona, nenhuma tabela, e a API da lista nega 403.
 *
 * Stack: `docker compose -p ptiseg030 …` (ver o cabeçalho de `admin-access-cells-visual`); a API e o banco
 * vêm de `ABAC_API_URL` / `ABAC_TEST_DB_URL` (helper `abac-stack-helper`).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  ABAC_API_URL,
  cleanupStaffAndGroup,
  grantCell,
  loginAs,
  meAuthz,
  pollAuthz,
  scalar,
  psql,
  seedStaffInGroup,
  tokenFor,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ADMIN_USER: MockUser = { uid: `e2e-seg-adm-${RUN_ID}`, email: `e2e-seg-adm-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const SEM_CELULA: MockUser = { uid: `e2e-seg-sem-${RUN_ID}`, email: `e2e-seg-sem-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const RESOURCE = 'catalog_therapeutic_segments';
// Só letras no rótulo: sequência longa de dígitos é lida como documento/telefone e recusada (guarda de PII do servidor, 400).
const LABEL = `Segmento e2e ${Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 8)}`;
const MENU = 'Segmentos (Ana Care)';
const ROTA = '/admin/catalogos/segmentos';

let adminGroup = '';
let semGroup = '';
let novoId = '';

const nav = (page: Page) => page.getByRole('navigation').first();
const link = (page: Page, nome: string) => nav(page).getByRole('link', { name: nome, exact: true });
const totalNoBanco = (): number => Number(scalar(`SELECT count(*) FROM therapeutic_segments`));
const semeados = (): string[] => psql(`SELECT label FROM therapeutic_segments WHERE created_by = 'seed:495' ORDER BY sort_order`).trim().split('\n');

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 030 — catálogo de segmentos (Ana Care): um HUMANO lê o seed, cria, esbarra no duplicado e desativa; sem a célula, nada aparece @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    ({ groupId: adminGroup } = seedStaffInGroup({ uid: ADMIN_USER.uid, email: ADMIN_USER.email, groupName: `E2E segmentos ${RUN_ID}`, country: 'AR' }));
    for (const action of ['read', 'create', 'update']) grantCell(adminGroup, RESOURCE, action);
    // Conta sem a célula de segmentos: tem UMA célula qualquer (como no molde do menu) — o que importa é a ausência desta.
    ({ groupId: semGroup } = seedStaffInGroup({ uid: SEM_CELULA.uid, email: SEM_CELULA.email, groupName: `E2E sem segmentos ${RUN_ID}`, country: 'AR' }));
    grantCell(semGroup, 'patient', 'read');
  });
  test.afterAll(() => {
    psql(`DELETE FROM therapeutic_segments WHERE label = '${LABEL}'`);
    cleanupStaffAndGroup(ADMIN_USER.uid, adminGroup);
    cleanupStaffAndGroup(SEM_CELULA.uid, semGroup);
  });

  test('feliz: menu → lê as 13 linhas semeadas na ordem → Nueva opción (click + keyboard.type) → linha na tela e no banco → desativa → "Inactiva"', async ({ page, request }) => {
    // Pré-condição: engine ON e o contrato real traz as 3 células de segmentos para a conta com acesso.
    const { status, body: authz } = await meAuthz(request, ADMIN_USER);
    expect(status).toBe(200);
    expect(authz.enforcement, 'a API precisa estar com PERMISSION_ENGINE_ENABLED=true').toBe('on');
    expect([...authz.permissions].sort()).toEqual([`${RESOURCE}:create`, `${RESOURCE}:read`, `${RESOURCE}:update`]);
    expect(semeados()).toHaveLength(13);

    await loginAs(page, ADMIN_USER);
    await expect(link(page, MENU)).toBeVisible({ timeout: 15_000 });
    const lista = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/therapeutic-catalogs/segments' && r.request().method() === 'GET');
    await link(page, MENU).click();
    await expect(page).toHaveURL(new RegExp(`${ROTA}$`));
    expect((await lista).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Segmentos del proyecto terapéutico (Ana Care)' })).toBeVisible({ timeout: 30_000 });

    const table = page.getByTestId('therapeutic-catalog-table');
    await expect(table).toBeVisible();
    await expect(table.locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(totalNoBanco());
    // As 13 primeiras linhas da tela são os 13 rótulos do seed, na ordem de `sort_order` (valor lido da TELA).
    const doSeed = semeados();
    const naTela = await table.locator('[data-testid^="therapeutic-catalog-label-"]').allInnerTexts();
    expect(naTela.slice(0, 13).map((s) => s.trim())).toEqual(doSeed);
    await expect(table).toHaveScreenshot('catalogo-segmentos-seed.png', { maxDiffPixelRatio: 0.02 });

    // ── Nueva opción ────────────────────────────────────────────────────────────────────────
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled();
    const input = page.getByTestId('therapeutic-catalog-label-input');
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.type(LABEL);
    expect(await input.inputValue()).toBe(LABEL);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/segments$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resposta = await created;
    const corpo = await resposta.text();
    expect(resposta.status(), corpo).toBe(201);
    const body = JSON.parse(corpo) as { data: { id: string; label: string; active: boolean } };
    expect(body.data.label).toBe(LABEL);
    novoId = body.data.id;
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-label-${novoId}`)).toHaveText(LABEL);
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Activa');
    expect(scalar(`SELECT count(*) FROM therapeutic_segments WHERE id = '${novoId}' AND active AND created_by <> 'seed:495'`)).toBe('1');
    expect(semeados()).toEqual(doSeed); // o seed segue intacto

    // ── Desativar ───────────────────────────────────────────────────────────────────────────
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/segments/${novoId}`));
    await page.getByTestId(`therapeutic-catalog-toggle-${novoId}`).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Inactiva');
    expect(scalar(`SELECT active::text || ',' || (deactivated_at IS NOT NULL)::text FROM therapeutic_segments WHERE id = '${novoId}'`)).toBe('false,true');
  });

  test('alt 1: o rótulo de um segmento do seed com outra caixa e espaços → 409, frase es-AR na tela, banco com 1 linha só', async ({ page }) => {
    const existente = semeados()[3];
    const antes = totalNoBanco();
    await loginAs(page, ADMIN_USER);
    await page.goto(ROTA);
    await expect(page.getByTestId('therapeutic-catalog-table')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    const input = page.getByTestId('therapeutic-catalog-label-input');
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.type(`  ${existente.toUpperCase()}  `);
    const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/segments$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(409);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText('Ya existe una opción activa con ese texto');
    await expect(modal).toBeVisible(); // segue aberta para o humano corrigir
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(modal).toHaveCount(0);
    expect(totalNoBanco()).toBe(antes);
    expect(Number(scalar(`SELECT count(*) FROM therapeutic_segments WHERE active AND lower(btrim(label)) = lower('${existente}')`))).toBe(1);
  });

  test('alt 2: conta SEM `catalog_therapeutic_segments:read` (engine ligado) — sem item no menu, a rota redireciona, nenhuma tabela, a API da lista nega 403', async ({ page, request }) => {
    const after = await pollAuthz(request, SEM_CELULA, (b) => Array.isArray(b?.permissions) && b.permissions.includes('patient:read'));
    expect(after.body.permissions).toEqual(['patient:read']);
    expect(after.body.enforcement).toBe('on');

    await loginAs(page, SEM_CELULA);
    await expect(link(page, 'Pacientes')).toBeVisible({ timeout: 15_000 });
    await expect(link(page, MENU)).toHaveCount(0);

    await page.goto(ROTA);
    await expect(page).not.toHaveURL(new RegExp(`${ROTA}$`), { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Segmentos del proyecto terapéutico (Ana Care)' })).toHaveCount(0);
    await expect(page.getByTestId('therapeutic-catalog-table')).toHaveCount(0);
    await expect(page.locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(0); // o destino do redirect (/admin) tem a própria tabela; do catálogo, nenhuma linha

    const direta = await request.get(`${ABAC_API_URL}/api/admin/therapeutic-catalogs/segments`, {
      headers: { Authorization: `Bearer ${tokenFor(SEM_CELULA)}` },
      failOnStatusCode: false,
    });
    expect(direta.status()).toBe(403);
  });
});
