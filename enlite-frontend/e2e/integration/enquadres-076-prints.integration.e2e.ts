/**
 * enquadres-076-prints.integration.e2e.ts — SÓ PRINTS da tela real da lista global de enquadres (spec 076, T-18; spec §7 item 4).
 * NÃO é regressão: não afirma regra de negócio (quem afirma é `group-simulation-enquadres-076`). Navega como humano (clique + teclado,
 * valores lidos da tela) numa stack REAL (frontend + API + Postgres, engine ABAC ligado), com a massa sintética por SQL de
 * `helpers/enquadres-076-seed.ts`, e grava `page.screenshot` (viewport 1440x900) + `<nome>.url.txt` (de `page.url()`) onde está `PRINTS_076_DIR`.
 * Nenhum clique cria/convoca/cancela/encerra evento: só leitura (o Kanban é aberto e fotografado, nada mais).
 *
 * Fora de todo `--grep` do CI: o nome do arquivo/título não casa nenhum token do `_frontend-integration.yml`/`pr-gate.yml`; e, por
 * garantia contra uma execução sem `--grep` (que roda `e2e/integration/*` inteiro, com o engine desligado), o spec SE PULA sem a env
 * `PRINTS_076_DIR`. Rodar à mão: `PRINTS_076_DIR=<pasta> ABAC_API_URL=… ABAC_TEST_DB_URL=… E2E_PG_CONTAINER=… npx playwright test
 * --project=integration --grep enquadres-076-prints`.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo, escolherVariosNoCombo } from '../helpers/combobox';
import { seedEnquadres076, cleanupEnquadres076, somaDias, digitadoDe, type Seed076 } from '../helpers/enquadres-076-seed';

const OUT = process.env.PRINTS_076_DIR ?? '';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST_A_NAME = 'Entrevistadora A E2E076';
const HOST_B_NAME = 'Entrevistador B E2E076';
const chefeUid = `e2e-076p-chefe-${RUN_ID}`;
const chefe: MockUser = { uid: chefeUid, email: `${chefeUid}@e2e.test`, role: 'admin', country: 'AR' };
const soVagaUid = `e2e-076p-sovaga-${RUN_ID}`;
const soVaga: MockUser = { uid: soVagaUid, email: `${soVagaUid}@e2e.test`, role: 'admin', country: 'AR' };
let seed: Seed076;
let chefeGroupId = '';
let soVagaGroupId = '';

async function print(page: Page, nome: string, comUrl = false): Promise<void> {
  await page.screenshot({ path: join(OUT, `${nome}.png`) });
  if (comUrl) writeFileSync(join(OUT, `${nome}.url.txt`), `${page.url()}\n`);
}

async function listaPronta(page: Page): Promise<void> {
  await expect(page.getByTestId('enquadres-totals')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('enquadres-region')).toHaveAttribute('aria-busy', 'false');
}

async function digitarData(page: Page, testId: string, iso: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(digitadoDe(iso));
  await expect(campo).toHaveValue(iso);
}

async function abrirListaPeloMenu(page: Page): Promise<void> {
  const nav = page.getByRole('navigation').first();
  await expect(nav.locator('a[href="/admin/vacancies"]')).toBeVisible({ timeout: 20_000 });
  await nav.locator('a[href="/admin/enquadres"]').click();
  await expect(page).toHaveURL(/\/admin\/enquadres/);
  await listaPronta(page);
}

test.describe('enquadres-076-prints — prints da lista global de enquadres (spec 076, T-18) @prints', () => {
  test.skip(OUT === '', 'só gera prints com PRINTS_076_DIR (nunca no CI)');
  test.setTimeout(300_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    chefeGroupId = seedStaffInGroup({ uid: chefeUid, email: chefe.email, groupName: `Enq076p Chefe ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [
      ['vacancy', 'read'], ['patient_identity', 'read'], ['funnel', 'read'], ['match', 'read'],
      ['enquadre_event', 'read'], ['enquadre_event', 'create'], ['enquadre_event', 'update'], ['enquadre_result', 'update'],
    ] as Array<[string, string]>) grantCell(chefeGroupId, r, a);
    soVagaGroupId = seedStaffInGroup({ uid: soVagaUid, email: soVaga.email, groupName: `Enq076p SoVaga ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(soVagaGroupId, 'vacancy', 'read');
    grantCell(soVagaGroupId, 'dashboard', 'read'); // só para a página de aterrissagem do print não mostrar um erro de painel alheio ao 076
    seed = seedEnquadres076(RUN_ID, chefeUid, HOST_A_NAME, HOST_B_NAME);
  });

  test.afterAll(() => {
    if (OUT === '') return;
    cleanupEnquadres076(seed);
    cleanupStaffAndGroup(chefeUid, chefeGroupId);
    cleanupStaffAndGroup(soVagaUid, soVagaGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Enq076p %${RUN_ID}'`);
  });

  test('prints 01-06 e 08: semana atual, importação travada, filtros, Kanban pelo link, volta, vazio, es e pt-BR', async ({ page }) => {
    await loginAs(page, chefe);
    await abrirListaPeloMenu(page);
    const semana0 = { from: await page.getByTestId('enquadres-filter-from').inputValue(), to: await page.getByTestId('enquadres-filter-to').inputValue() };
    await expect(page.getByTestId('enquadres-row')).not.toHaveCount(0);
    await print(page, '01-lista-semana-atual');
    await expect(page.getByTestId('enquadres-import-blocked')).toBeVisible();
    await print(page, '04-importacao-travada');
    await print(page, '08a-lista-es');

    // 02 — filtros: Estado "Abierto" e Entrevistador (aplicam na hora), período das duas semanas e busca pelo nº do caso (Aplicar).
    await escolherVariosNoCombo(page, page.getByTestId('enquadres-filter-status'), ['Abierto']);
    await escolherNoCombo(page, page.getByTestId('enquadres-filter-host'), HOST_A_NAME);
    await digitarData(page, 'enquadres-filter-from', semana0.from);
    await digitarData(page, 'enquadres-filter-to', somaDias(semana0.to, 7));
    const busca = page.getByTestId('enquadres-filter-search');
    await busca.click();
    await expect(busca).toBeFocused();
    await page.keyboard.type(String(seed.caseNumber));
    await expect(busca).toHaveValue(String(seed.caseNumber));
    await page.getByTestId('enquadres-filter-apply').click();
    await expect(page).toHaveURL(/status=open/);
    await expect(page).toHaveURL(/host=/);
    await expect(page).toHaveURL(new RegExp(`q=${seed.caseNumber}`));
    await listaPronta(page);
    await expect(page.getByTestId('enquadres-row')).toHaveCount(3); // e1, e3 e n1: abertos da entrevistadora A nas duas semanas
    await print(page, '02-lista-com-filtros', true);

    // 05 — clique numa linha: Kanban do evento na vaga, com o link na barra de endereço (guardado no .url.txt).
    await page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.n1}"]`).getByTestId('enquadres-row-host').click();
    await expect(page).toHaveURL(new RegExp(`tab=enquadre&event=${seed.events.n1}`));
    await expect(page.getByTestId('enquadre-tab')).toHaveAttribute('data-selected-event', seed.events.n1, { timeout: 20_000 });
    await expect(page.getByTestId('enquadre-kanban')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('enquadre-tab')).toBeInViewport({ timeout: 10_000 }); // a rolagem é do próprio deep link (nenhum scroll manual)
    await page.waitForTimeout(400);
    await print(page, '05-kanban-deep-link', true);

    // 06 — voltar do navegador: a lista com os mesmos filtros.
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/enquadres\?.*status=open/);
    await listaPronta(page);
    await expect(page.getByTestId('enquadres-row')).toHaveCount(3);
    await expect(page.getByTestId('enquadres-filter-search')).toHaveValue(String(seed.caseNumber));
    await print(page, '06-volta-com-filtros', true);

    // 03 — período sem evento.
    await digitarData(page, 'enquadres-filter-from', '2020-01-06');
    await digitarData(page, 'enquadres-filter-to', '2020-01-12');
    await page.getByTestId('enquadres-filter-apply').click();
    await expect(page.getByTestId('enquadres-empty')).toBeVisible({ timeout: 20_000 });
    await listaPronta(page);
    await print(page, '03-estado-vazio');

    // 08b — a mesma lista em português, com o idioma trocado pelo seletor do perfil (clique).
    await page.goto('/admin/mi-cuenta');
    await page.getByTestId('language-pt-BR').click();
    await expect(page.getByTestId('language-pt-BR')).toHaveAttribute('aria-pressed', 'true');
    await abrirListaPeloMenu(page);
    await expect(page.getByTestId('enquadres-row')).not.toHaveCount(0);
    await print(page, '08b-lista-pt-BR');
  });

  test('prints 07a e 07b: usuário sem enquadre_event:read — menu sem o item e rota direta barrada', async ({ page }) => {
    await loginAs(page, soVaga);
    const nav = page.getByRole('navigation').first();
    await expect(nav.locator('a[href="/admin/vacancies"]')).toBeVisible({ timeout: 20_000 });
    await nav.locator('a[href="/admin/vacancies"]').click(); // a tela que ele PODE abrir, com o menu sem "Encuadres"
    await expect(page).toHaveURL(/\/admin\/vacancies/);
    await expect(nav.locator('a[href="/admin/enquadres"]')).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await print(page, '07a-sem-permissao-menu');
    await page.goto('/admin/enquadres');
    await expect(page).not.toHaveURL(/\/admin\/enquadres/, { timeout: 20_000 });
    await expect(page.getByTestId('enquadres-page')).toHaveCount(0);
    expect(page.url(), 'a URL final não é a da lista').not.toContain('/admin/enquadres');
    await page.waitForTimeout(800);
    await print(page, '07b-sem-permissao-rota', true);
  });
});
