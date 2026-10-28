/**
 * group-simulation-enquadres-076.integration.e2e.ts @integration — spec 076 (lista global de enquadres em `/admin/enquadres`), T-17.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique/teclado de humano (`loginAs`, `keyboard.type` nas datas, valores lidos da tela). A massa vai por SQL (nenhuma chamada de
 * criar/convocar/cancelar/encerrar evento): a lista e o Kanban só LEEM — nenhum Calendar/Meet/WhatsApp é tocado.
 *
 *  1 feliz  — menu "Encuadres" -> período padrão = semana atual (totais da tela = contagem SQL) -> Desde/Hasta para a semana seguinte
 *             (lista e totais mudam) -> clique numa linha -> `enquadre-tab[data-selected-event=<id>]` e URL `?tab=enquadre&event=<id>`
 *             -> voltar do navegador -> a lista com os MESMOS `from`/`to` e os mesmos totais. Há 1 evento com importação travada.
 *  2 alt    — período sem evento: `enquadres-empty` com o intervalo e "0 encuadres · 0 convocados".
 *  3 alt    — staff só com `vacancy:read`: item ausente do menu, `/admin/enquadres` direto termina fora da lista e a API responde 403.
 *  4 alt    — recusa do SERVIDOR: ator só-AR abre `?country=BR`, a API responde 403 `COUNTRY_SCOPE_REQUIRED` e a tela mostra a mensagem
 *             traduzida (pelo `code`) + "Reintentar", sem nenhuma linha.
 *
 * ⚠️ Precisa do engine ABAC LIGADO — por isso o token `group-simulation-enquadres-076` (prefixo de arquivo) entra na `--grep` do job
 * `integration-e2e-group-simulation`. Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`.
 * Dados SINTÉTICOS ("Ficticio NN", e-mails `@example.test`, caso >= 960000).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { seedEnquadres076, cleanupEnquadres076, contagemSql, somaDias, digitadoDe, type Seed076 } from '../helpers/enquadres-076-seed';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST_A_NAME = 'Entrevistadora A E2E076';
const HOST_B_NAME = 'Entrevistador B E2E076';

const chefeUid = `e2e-076-chefe-${RUN_ID}`;
const chefe: MockUser = { uid: chefeUid, email: `${chefeUid}@e2e.test`, role: 'admin', country: 'AR' };
const soVagaUid = `e2e-076-sovaga-${RUN_ID}`;
const soVaga: MockUser = { uid: soVagaUid, email: `${soVagaUid}@e2e.test`, role: 'admin', country: 'AR' };

let seed: Seed076;
let chefeGroupId = '';
let soVagaGroupId = '';

/** "N encuadre(s) · M convocado(s)" como a tela escreve (es, plural do i18n). */
const totaisEs = (eventos: number, convocados: number): string =>
  `${eventos} ${eventos === 1 ? 'encuadre' : 'encuadres'} · ${convocados} ${convocados === 1 ? 'convocado' : 'convocados'}`;

/** Digita como uma pessoa: clique no campo, volta ao 1º segmento (mês) pelo teclado, digita e LÊ o valor da tela. */
async function digitarData(page: Page, campo: Locator, iso: string): Promise<void> {
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(digitadoDe(iso));
  await expect(campo).toHaveValue(iso);
}

async function periodoNaTela(page: Page): Promise<{ from: string; to: string }> {
  return {
    from: await page.getByTestId('enquadres-filter-from').inputValue(),
    to: await page.getByTestId('enquadres-filter-to').inputValue(),
  };
}

async function abrirListaPeloMenu(page: Page): Promise<void> {
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'Vacantes' })).toBeVisible({ timeout: 20_000 });
  await nav.getByRole('link', { name: 'Encuadres' }).click();
  await expect(page).toHaveURL(/\/admin\/enquadres/);
  await expect(page.getByTestId('enquadres-totals')).toBeVisible({ timeout: 20_000 });
}

test.describe('group-simulation-enquadres-076 — lista global de enquadres: semana, período, Kanban pelo link, volta com filtros, vazio e sem permissão (spec 076) @integration', () => {
  test.setTimeout(240_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(() => {
    // Células concedidas ANTES do 1º request (PERMISSION_CACHE_TTL_MS=30000 no override do job).
    chefeGroupId = seedStaffInGroup({ uid: chefeUid, email: chefe.email, groupName: `Enq076 Chefe ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [
      ['vacancy', 'read'], ['patient_identity', 'read'], ['funnel', 'read'], ['match', 'read'],
      ['enquadre_event', 'read'], ['enquadre_event', 'create'], ['enquadre_event', 'update'], ['enquadre_result', 'update'],
    ] as Array<[string, string]>) grantCell(chefeGroupId, r, a);
    soVagaGroupId = seedStaffInGroup({ uid: soVagaUid, email: soVaga.email, groupName: `Enq076 SoVaga ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(soVagaGroupId, 'vacancy', 'read');
    seed = seedEnquadres076(RUN_ID, chefeUid, HOST_A_NAME, HOST_B_NAME);
  });

  test.afterAll(() => {
    cleanupEnquadres076(seed);
    cleanupStaffAndGroup(chefeUid, chefeGroupId);
    cleanupStaffAndGroup(soVagaUid, soVagaGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Enq076 %${RUN_ID}'`);
  });

  test('enquadre-076 feliz: menu -> semana atual (totais = SQL) -> semana seguinte -> clique abre o Kanban do evento -> voltar com os mesmos filtros', async ({ page }) => {
    await loginAs(page, chefe);
    await abrirListaPeloMenu(page);

    // Semana atual: o período padrão vem do servidor e a tela o mostra em Desde/Hasta; o total tem de bater com o SQL do mesmo intervalo.
    const semana0 = await periodoNaTela(page);
    expect(semana0.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(semana0.to, 'semana = 7 dias (segunda a domingo)').toBe(somaDias(semana0.from, 6));
    const sql0 = contagemSql(semana0.from, semana0.to);
    expect(sql0.eventos, 'a massa põe >= 3 eventos na semana atual').toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('enquadres-totals')).toHaveText(totaisEs(sql0.eventos, sql0.convocados));
    await expect(page.getByTestId('enquadres-row')).toHaveCount(sql0.eventos);
    for (const id of [seed.events.e1, seed.events.e2, seed.events.e3]) {
      await expect(page.locator(`[data-testid="enquadres-row"][data-event-id="${id}"]`)).toBeVisible();
    }
    await expect(page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.n1}"]`)).toHaveCount(0);
    // O evento com importação travada mostra o chip "Bloqueada" com o motivo traduzido no title.
    const travada = page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.e3}"]`).getByTestId('enquadres-import-blocked');
    await expect(travada).toHaveAttribute('data-reason', 'no_link');
    await expect(travada).toHaveText('Bloqueada');
    await expect(travada).toHaveAttribute('title', 'Importación bloqueada: El responsable no vinculó su cuenta de Tactiq');
    await expect(travada).toHaveAttribute('aria-label', 'Importación bloqueada: El responsable no vinculó su cuenta de Tactiq');

    // Semana seguinte: Desde/Hasta digitados, "Aplicar" clicado.
    const semana1 = { from: somaDias(semana0.from, 7), to: somaDias(semana0.to, 7) };
    await digitarData(page, page.getByTestId('enquadres-filter-from'), semana1.from);
    await digitarData(page, page.getByTestId('enquadres-filter-to'), semana1.to);
    await page.getByTestId('enquadres-filter-apply').click();
    await expect(page).toHaveURL(new RegExp(`from=${semana1.from}&to=${semana1.to}`));
    const sql1 = contagemSql(semana1.from, semana1.to);
    expect(sql1.eventos).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('enquadres-totals')).toHaveText(totaisEs(sql1.eventos, sql1.convocados));
    expect(totaisEs(sql1.eventos, sql1.convocados), 'a troca de semana muda os totais').not.toBe(totaisEs(sql0.eventos, sql0.convocados));
    await expect(page.getByTestId('enquadres-row')).toHaveCount(sql1.eventos);
    await expect(page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.n1}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.e1}"]`)).toHaveCount(0);
    const totaisDaLista = (await page.getByTestId('enquadres-totals').innerText()).trim();

    // Clique na linha: o Kanban DAQUELE evento abre na vaga (assert pelo evento) e a URL é o link compartilhável.
    await page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.n1}"]`).getByTestId('enquadres-row-host').click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${seed.vacancyId}\\?tab=enquadre&event=${seed.events.n1}`));
    await expect(page.getByTestId('enquadre-tab')).toHaveAttribute('data-selected-event', seed.events.n1, { timeout: 20_000 });

    // Voltar do navegador: a lista volta com as MESMAS datas (na URL e nos campos) e os mesmos totais.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/admin/enquadres\\?.*from=${semana1.from}&to=${semana1.to}`));
    await expect(page.getByTestId('enquadres-filter-from')).toHaveValue(semana1.from);
    await expect(page.getByTestId('enquadres-filter-to')).toHaveValue(semana1.to);
    await expect(page.getByTestId('enquadres-totals')).toHaveText(totaisDaLista);
    await expect(page.locator(`[data-testid="enquadres-row"][data-event-id="${seed.events.n1}"]`)).toBeVisible();
  });

  test('enquadre-076 alternativo 1 — período sem evento: estado vazio com o intervalo e "0 encuadres · 0 convocados"', async ({ page }) => {
    await loginAs(page, chefe);
    await abrirListaPeloMenu(page);
    const vazio = { from: '2020-01-06', to: '2020-01-12' }; // segunda a domingo, bem antes de qualquer massa
    expect(contagemSql(vazio.from, vazio.to).eventos, 'o período escolhido está mesmo sem evento').toBe(0);
    await digitarData(page, page.getByTestId('enquadres-filter-from'), vazio.from);
    await digitarData(page, page.getByTestId('enquadres-filter-to'), vazio.to);
    await page.getByTestId('enquadres-filter-apply').click();
    await expect(page.getByTestId('enquadres-empty')).toHaveText('No hay encuadres entre 06/01/2020 y 12/01/2020.', { timeout: 20_000 });
    await expect(page.getByTestId('enquadres-totals')).toHaveText('0 encuadres · 0 convocados');
    await expect(page.getByTestId('enquadres-row')).toHaveCount(0);
  });

  test('enquadre-076 alternativo 2 — sem enquadre_event:read: item ausente do menu, rota direta barrada e API 403', async ({ page, request }) => {
    await loginAs(page, soVaga);
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Vacantes' }), 'o menu carregou (controle positivo)').toBeVisible({ timeout: 20_000 });
    await expect(nav.getByRole('link', { name: 'Encuadres' })).toHaveCount(0);

    await page.goto('/admin/enquadres');
    await expect(page).not.toHaveURL(/\/admin\/enquadres/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/admin\/?(dashboard\/?)?$/);
    await expect(page.getByTestId('enquadres-page')).toHaveCount(0);

    const res = await request.get(`${ABAC_API_URL}/api/admin/enquadre-events`, {
      headers: { Authorization: `Bearer ${tokenFor(soVaga)}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });

  test('enquadre-076 alternativo 3 — recusa do servidor: ator só-AR em ?country=BR vê a mensagem do code COUNTRY_SCOPE_REQUIRED e o botão de tentar de novo, sem linhas', async ({ page }) => {
    await loginAs(page, chefe);
    await abrirListaPeloMenu(page); // controle positivo: com o país do ator a lista abre e tem linhas
    await expect(page.getByTestId('enquadres-row').first()).toBeVisible();

    const recusa = page.waitForResponse((r) => r.url().includes('/api/admin/enquadre-events') && r.url().includes('country=BR'));
    await page.goto('/admin/enquadres?country=BR');
    const resp = await recusa;
    expect(resp.status()).toBe(403);
    expect((await resp.json()).code).toBe('COUNTRY_SCOPE_REQUIRED');

    await expect(page.getByTestId('enquadres-error')).toContainText('No tenés acceso al país elegido para esta lista.', { timeout: 20_000 });
    await expect(page.getByTestId('enquadres-retry')).toBeVisible();
    // Estado estável: nada esmaecido nem "carregando" (a região aria-busy só existe fora do erro; o fade de entrada de 220ms termina).
    await expect(page.getByTestId('enquadres-error')).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('enquadres-page').locator('xpath=..')).toHaveCSS('opacity', '1');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByTestId('enquadres-retry')).toHaveText('Intentar de nuevo');
    await expect(page.getByTestId('enquadres-row')).toHaveCount(0);
    await expect(page.getByTestId('enquadres-totals')).toHaveCount(0);
  });
});
