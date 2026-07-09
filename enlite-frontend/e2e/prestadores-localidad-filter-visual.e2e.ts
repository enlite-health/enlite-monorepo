/**
 * prestadores-localidad-filter-visual.e2e.ts  (projeto chromium-admin)
 *
 * ClickUp 86ajeu9fw — "Corrigir os Filtros na Tela de Prestadores".
 *
 * Prova visual (AUTH FIREBASE REAL + backend mockado via page.route) de que o
 * filtro de Localidad da tela /admin/workers volta a funcionar:
 *   - o dropdown de Localidad vem LIMPO (sem os códigos CPA lixo "AEJ/AOO/BSI"),
 *   - "Ciudad Autónoma de Buenos Aires" (CABA) aparece como opção — antes CABA
 *     nunca estava em city/state, só em work_zone/interest_zone,
 *   - ao selecionar CABA a listagem RETORNA prestadores (antes voltava vazio),
 *   - o request carrega o parâmetro `city`.
 *
 * Backend mockado — NÃO toca o Postgres compartilhado (seguro rodar em paralelo).
 * Screenshot obrigatório via toHaveScreenshot() (hard requirement do CLAUDE.md).
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAsAdmin, mockAdminBaseRoutes, ok } from './helpers/kanban-notes-e2e-helper';

const CABA_LABEL = 'Ciudad Autónoma de Buenos Aires';

// Dropdown JÁ normalizado pelo backend: sem "AEJ/AOO/BSI"; CABA presente.
const FILTER_OPTIONS = {
  states: ['Buenos Aires', CABA_LABEL, 'Córdoba'],
  cities: ['Buenos Aires', CABA_LABEL, 'Lanús', 'Mar del Plata'],
  experienceTypes: ['TEA', 'DOWN'],
  preferredTypes: ['home', 'institutional'],
};

const CABA_WORKERS = [
  {
    id: 'w-caba-0001-0001-0001-000000000001',
    name: 'Ricardo Gómez',
    email: 'ricardo.gomez@e2e.test',
    casesCount: 1,
    documentsComplete: true,
    documentsStatus: 'approved',
    platform: 'talentum',
    createdAt: '2026-05-10T10:00:00Z',
  },
  {
    id: 'w-caba-0002-0002-0002-000000000002',
    name: 'Miguel Torres',
    email: 'miguel.torres@e2e.test',
    casesCount: 0,
    documentsComplete: true,
    documentsStatus: 'approved',
    platform: 'talentum',
    createdAt: '2026-05-11T10:00:00Z',
  },
];

function workersBody(workers: typeof CABA_WORKERS) {
  return { status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: workers, total: workers.length, limit: 20, offset: 0 }) };
}

async function mockWorkersScreen(page: Page, capture: { url: string }): Promise<void> {
  await mockAdminBaseRoutes(page);

  // Tag filter reads an ARRAY — the base catch-all returns data:null which would
  // crash WorkerTagMultiSelect (.filter on null). Return an empty tag list.
  await page.route('**/api/admin/worker-tags', (route: Route) => route.fulfill(ok([])));

  await page.route('**/api/admin/workers/filter-options', (route: Route) =>
    route.fulfill(ok(FILTER_OPTIONS)),
  );
  await page.route('**/api/admin/workers/stats', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { today: 1, yesterday: 0, sevenDaysAgo: 2 } }) }),
  );
  await page.route('**/api/admin/workers/case-options', (route: Route) =>
    route.fulfill(ok([])),
  );

  // Listagem: com o filtro de Localidad=CABA volta gente (antes voltava vazio).
  await page.route('**/api/admin/workers*', (route: Route) => {
    const url = route.request().url();
    if (url.includes('/stats') || url.includes('/case-options') || url.includes('/filter-options')) {
      return route.continue();
    }
    capture.url = url;
    const hasCity = /[?&]city=/.test(url);
    return route.fulfill(workersBody(hasCity ? CABA_WORKERS : []));
  });
}

test.describe('Prestadores — filtro de Localidad (86ajeu9fw)', () => {
  test.setTimeout(60000);
  test.use({ viewport: { width: 1280, height: 900 } });

  test('selecionar Localidad=CABA retorna prestadores e o dropdown vem sem lixo', async ({ page }) => {
    const capture = { url: '' };
    await mockWorkersScreen(page, capture);
    await loginAsAdmin(page);

    await page.goto('/admin/workers');

    const profileFilters = page.locator('[data-testid="worker-profile-filters"]');
    await expect(profileFilters).toBeVisible({ timeout: 15000 });

    // Localidad é o 8º <select> nativo da linha de filtros de perfil
    // (Profesión, Rango, Experiencia, Preferido, Idioma, Sexo, Provincia, Localidad).
    const localidadSelect = profileFilters.locator('select').nth(7);
    await expect(localidadSelect).toBeVisible({ timeout: 10000 });

    // Dropdown limpo: CABA presente, códigos CPA lixo ausentes.
    const optionValues = await localidadSelect.locator('option').allInnerTexts();
    expect(optionValues).toContain(CABA_LABEL);
    expect(optionValues.join('|')).not.toMatch(/\b(AEJ|AOO|ARP|BSI|GTJ)\b/);

    // Seleciona CABA → dispara a listagem filtrada.
    await localidadSelect.selectOption({ label: CABA_LABEL });

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers?') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        !resp.url().includes('/filter-options') &&
        /[?&]city=/.test(resp.url()),
      { timeout: 10000 },
    );

    // Resultado: prestadores da CABA renderizados (antes: nenhum).
    await expect(page.getByText('Ricardo Gómez').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Miguel Torres').first()).toBeVisible({ timeout: 5000 });
    expect(decodeURIComponent(capture.url)).toContain('city=');

    await expect(page).toHaveScreenshot('prestadores-localidad-caba-results.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });
});
