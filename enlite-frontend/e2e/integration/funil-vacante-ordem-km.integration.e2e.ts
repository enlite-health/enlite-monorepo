/**
 * funil-vacante-ordem-km.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 3 da change cadeia-paciente-vacante-itinerario
 * (`CH/execucao/fase-3.md`, P25): a distância do candidato (DX-3.10) ordena
 * o funil por km crescente, no modo lista E no Kanban (DX-3.11), a partir da
 * mesma API (`GET /api/admin/vacancies/:id/funnel`). Frontend real (Vite) +
 * backend real (Docker, USE_MOCK_AUTH=true) + Postgres real.
 */

import { test, expect } from '@playwright/test';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff, seedVacancyWithCandidatesAtKm } from '../helpers/vacancy-notes-e2e-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_ADMIN: MockUser = {
  uid: 'e2e-int-admin-funil-vacante-km',
  email: 'admin.funil.vacante.km@e2e.test',
  role: 'admin',
  country: 'AR',
};

interface FunnelItem {
  id: string;
  distanceKm: number | null;
}

test.describe('funil da vacante — ordem por km @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_ADMIN, 'E2E Admin Funil Km');
  });

  test.afterAll(() => {
    try {
      cleanupMockStaff(MOCK_ADMIN);
    } catch (err) {
      console.error('[cleanup] staff falhou (seguindo)', err);
    }
  });

  test('funil-vacante-ordem-km', async ({ page, request }) => {
    // Coluna Invitados, ordem de hoje ("mais recente primeiro") invertida:
    // 40, sem endereço, 3, 12 km — a ordem esperada é a das distâncias
    // semeadas (3, 12, 40, null), nunca derivada da resposta.
    const seed = seedVacancyWithCandidatesAtKm([40, null, 3, 12]);
    const [wja40, wjaNull, wja3, wja12] = seed.wjaIds;
    const expectedOrder = [wja3, wja12, wja40, wjaNull];

    try {
      // 1. API: stages.INVITED tem distanceKm ≈ 3/12/40, e null para o sem endereço.
      const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${seed.vacancyId}/funnel`, {
        headers: { Authorization: `Bearer ${tokenFor(MOCK_ADMIN)}` },
      });
      expect(res.ok(), 'GET funnel falhou').toBe(true);
      const body = (await res.json()) as { data: { stages: Record<string, FunnelItem[]> } };
      const invited = body.data.stages.INVITED;
      const byId = (id: string) => invited.find((item) => item.id === id);

      expect(byId(wja3)?.distanceKm, 'wja3.distanceKm').not.toBeNull();
      expect(byId(wja3)!.distanceKm as number, 'wja3.distanceKm').toBeCloseTo(3, 0);
      expect(byId(wja12)?.distanceKm, 'wja12.distanceKm').not.toBeNull();
      expect(byId(wja12)!.distanceKm as number, 'wja12.distanceKm').toBeCloseTo(12, 0);
      expect(byId(wja40)?.distanceKm, 'wja40.distanceKm').not.toBeNull();
      expect(byId(wja40)!.distanceKm as number, 'wja40.distanceKm').toBeCloseTo(40, 0);
      expect(byId(wjaNull)?.distanceKm, 'wjaNull.distanceKm').toBeNull();

      // 2. loginAs; abre a vaga (modo lista, aba Invitados padrão).
      await loginAs(page, MOCK_ADMIN);
      await page
        .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), seed.vacancyId)
        .catch(() => {});
      const funnelTableRe = new RegExp(`/vacancies/${seed.vacancyId}/funnel-table(\\?|$)`);
      const [funnelTableResponse] = await Promise.all([
        page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
        page.goto(`/admin/vacancies/${seed.vacancyId}`),
      ]);
      expect(funnelTableResponse.ok(), 'GET funnel-table falhou').toBe(true);
      await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });

      const listIds = await page
        .locator('[data-testid^="funnel-row-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(listIds, 'ordem modo lista').toEqual(expectedOrder.map((id) => `funnel-row-${id}`));

      // 3. Kanban — mesma ordem.
      const funnelRe = new RegExp(`/vacancies/${seed.vacancyId}/funnel(\\?|$)`);
      const [kanbanResponse] = await Promise.all([
        page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
        page
          .getByRole('group', { name: 'Cambiar vista' })
          .getByRole('button', { name: /Kanban/i })
          .click(),
      ]);
      expect(kanbanResponse.ok(), 'GET funnel (kanban) falhou').toBe(true);
      await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });

      // Primeira linha depois da navegação ao Kanban: o print.
      if (process.env.PRINT_DIR) {
        await page.screenshot({ path: `${process.env.PRINT_DIR}/funil-kanban.png`, fullPage: true });
      }

      const kanbanIds = await page
        .locator('[data-testid="kanban-column-INVITED"] [data-testid^="kanban-card-"][data-stage]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(kanbanIds, 'ordem kanban').toEqual(expectedOrder.map((id) => `kanban-card-${id}`));
    } finally {
      seed.cleanup();
    }
  });

  // ── alt · 2 candidatos SEM endereço: nenhum erra, os 2 aparecem ─────────────
  test('funil-vacante-ordem-km-sem-endereco', async ({ page, request }) => {
    const seed = seedVacancyWithCandidatesAtKm([null, null]);
    const [wjaA, wjaB] = seed.wjaIds;
    const expectedIds = [wjaA, wjaB];

    try {
      // 1. API: os 2 têm distanceKm null, nenhum 500.
      const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${seed.vacancyId}/funnel`, {
        headers: { Authorization: `Bearer ${tokenFor(MOCK_ADMIN)}` },
      });
      expect(res.ok(), 'GET funnel falhou').toBe(true);
      const body = (await res.json()) as { data: { stages: Record<string, FunnelItem[]> } };
      const invited = body.data.stages.INVITED;
      expect(invited.map((item) => item.distanceKm), 'os 2 sem distância').toEqual([null, null]);

      // 2. Tela — modo lista: os 2 aparecem (ordem do backend, sem erro).
      await loginAs(page, MOCK_ADMIN);
      await page
        .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), seed.vacancyId)
        .catch(() => {});
      const funnelTableRe = new RegExp(`/vacancies/${seed.vacancyId}/funnel-table(\\?|$)`);
      const [funnelTableResponse] = await Promise.all([
        page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
        page.goto(`/admin/vacancies/${seed.vacancyId}`),
      ]);
      expect(funnelTableResponse.ok(), 'GET funnel-table falhou').toBe(true);
      await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });

      const listIds = await page
        .locator('[data-testid^="funnel-row-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(new Set(listIds), 'os 2 cards aparecem no modo lista').toEqual(
        new Set(expectedIds.map((id) => `funnel-row-${id}`)),
      );
      expect(listIds.length, 'nenhum a mais nem a menos').toBe(2);

      // 3. Kanban — os 2 aparecem também.
      const funnelRe = new RegExp(`/vacancies/${seed.vacancyId}/funnel(\\?|$)`);
      const [kanbanResponse] = await Promise.all([
        page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
        page
          .getByRole('group', { name: 'Cambiar vista' })
          .getByRole('button', { name: /Kanban/i })
          .click(),
      ]);
      expect(kanbanResponse.ok(), 'GET funnel (kanban) falhou').toBe(true);
      await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });

      const kanbanIds = await page
        .locator('[data-testid="kanban-column-INVITED"] [data-testid^="kanban-card-"][data-stage]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      expect(new Set(kanbanIds), 'os 2 cards aparecem no kanban').toEqual(
        new Set(expectedIds.map((id) => `kanban-card-${id}`)),
      );
      expect(kanbanIds.length, 'nenhum a mais nem a menos').toBe(2);
    } finally {
      seed.cleanup();
    }
  });
});
