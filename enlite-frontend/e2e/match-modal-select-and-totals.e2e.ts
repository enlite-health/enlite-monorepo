/**
 * match-modal-select-and-totals.e2e.ts  (projeto chromium-admin)
 *
 * ClickUp 86ajb48v1 — "Ajustes de Seleção na Função de Match".
 * Prova visual das duas mudanças de UI no modal "Match de candidatos":
 *   (a) AC1 — "Seleccionar todos" por agrupamento de Km (checkbox no header de
 *       cada bucket ≤ N km) marca todos os candidatos daquele grupo de uma vez.
 *   (b) AC3 — marcador de totais: total disponível em TODOS os raios × recrutados.
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI. Backend mockado via page.route
 * (padrão chromium-admin). Screenshot obrigatório via toHaveScreenshot()
 * (requisito hard de CLAUDE.md).
 */
import { test, expect, type Route } from '@playwright/test';
import {
  VACANCY_ID,
  emptyStages,
  loginAsAdmin,
  mockAdminBaseRoutes,
  mockVacancy,
  ok,
} from './helpers/kanban-notes-e2e-helper';

function candidate(over: Record<string, unknown>) {
  return {
    workerId: 'w', workerName: 'Candidato', workerPhone: '+5491100000000',
    occupation: 'AT', workZone: 'Palermo', distanceKm: 3, activeCasesCount: 0,
    overallStatus: 'REGISTERED', documentStatus: 'approved', matchScore: 80,
    internalNotes: null, alreadyApplied: false, messagedAt: null, ...over,
  };
}

// 4 disponíveis em vários raios; 1 já recrutado (messagedAt != null).
const CANDIDATES = [
  candidate({ workerId: 'w1', workerName: 'Ana García', distanceKm: 2.0 }),   // ≤ 5 km
  candidate({ workerId: 'w2', workerName: 'Bruno López', distanceKm: 4.5 }),  // ≤ 5 km
  candidate({ workerId: 'w3', workerName: 'Carla Méndez', distanceKm: 8.0, messagedAt: '2026-07-01T10:00:00Z' }), // > 5 ≤ 10, recrutado
  candidate({ workerId: 'w4', workerName: 'Diego Sosa', distanceKm: 15.0 }),  // > 10 ≤ 20
];

const MATCH_RESULTS = {
  jobPostingId: VACANCY_ID,
  lastMatchAt: '2026-07-08T12:00:00Z',
  totalCandidates: CANDIDATES.length,
  candidates: CANDIDATES,
};

test.describe('Match modal — select-all por Km + marcador de totais (auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('AC1 select-all por bucket + AC3 marcador disponíveis × recrutados', async ({ page }) => {
    await mockAdminBaseRoutes(page);

    // Vaga COM meet link → sem alerta de "faltan links", modal limpo.
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (r: Route) =>
      r.fulfill(ok({ ...mockVacancy, meet_link_1: 'https://meet.google.com/abc-defg-hij' })));

    // Funnel vazio (a tela abre em lista; o modal é aberto via "Hacer match").
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (r: Route) =>
      r.fulfill(ok({ stages: emptyStages(), totalEncuadres: 0 })));
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel-table**`, (r: Route) =>
      r.fulfill(ok({ rows: [], counts: {}, total: 0 })));

    // Match: POST /match e GET /match-results devolvem os mesmos candidatos.
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, (r: Route) =>
      r.fulfill(ok(MATCH_RESULTS)));
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match**`, (r: Route) =>
      r.fulfill(ok(MATCH_RESULTS)));

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${VACANCY_ID}`);

    // Abre o modal "Hacer match".
    await page.getByRole('button', { name: /Hacer match/i }).click();
    const modal = page.getByTestId('match-modal');
    await expect(modal).toBeVisible({ timeout: 20_000 });

    // AC3 — marcador de totais visível: disponíveis (4) × recrutados (1).
    const marker = page.getByTestId('match-totals-marker');
    await expect(marker).toBeVisible();
    await expect(marker).toContainText('4');
    await expect(marker).toContainText('1');
    await expect(modal).toHaveScreenshot('match-modal-totals-marker.png', {
      maxDiffPixelRatio: 0.02,
    });

    // AC1 — select-all do primeiro bucket (≤ 5 km) marca os 2 candidatos dele.
    const selectAll = modal.getByRole('checkbox', { name: /Seleccionar todos \(≤ 5 km\)/ });
    await expect(selectAll).toBeVisible();
    await selectAll.check();
    await expect(selectAll).toBeChecked();
    // Footer reflete 2 selecionados (os 2 do bucket ≤ 5 km).
    await expect(modal.getByText(/2 seleccionado/)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(modal).toHaveScreenshot('match-modal-select-all-km-group.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
