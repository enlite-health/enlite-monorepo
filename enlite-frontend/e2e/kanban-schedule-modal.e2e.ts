/**
 * kanban-schedule-modal.e2e.ts  (projeto chromium-admin)
 *
 * Prova VISUAL da captura da data da entrevista (change captura-data-entrevista, 30/07/2026).
 *
 * Até esta mudança o sistema registrava QUE a entrevista foi agendada e nunca QUANDO — por
 * isso lembrete de véspera, lembrete de 5min e marcação de falta nunca dispararam uma única
 * vez, e o card "Encuadres agendados esta semana" mostrava 0 para sempre.
 *
 * Prova aqui:
 *   1. mover para "Agendados" abre o modal pedindo data/hora
 *   2. confirmar envia interviewDate/interviewTime no PUT
 *   3. "ainda não sei" move o card SEM data (não bloqueia, não inventa horário)
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (sem conta real, sem emulador).
 *
 * Run: pnpm exec playwright test --project=chromium-admin kanban-schedule-modal
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { VACANCY_ID, emptyStages, mockAdminBaseRoutes, ok } from './helpers/kanban-notes-e2e-helper';

const WJA_ID = 'wja-sched-1';
const WORKER_ID = 'worker-sched-1';
const ENCUADRE_ID = 'enc-sched-1';

const MOCK_ADMIN = { uid: 'sched-admin-uid', email: 'sched.visual@e2e.test' };

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

const funnelCard = {
  id: WJA_ID,
  encuadreId: ENCUADRE_ID,
  workerId: WORKER_ID,
  workerName: 'Lucía Benítez',
  workerPhone: '+5491144445555',
  occupation: 'AT',
  interviewDate: null,
  interviewTime: null,
  meetLink: null,
  interviewResponse: null,
  resultado: null,
  attended: null,
  rejectionReasonCategory: null,
  rejectionReason: null,
  matchScore: 9.1,
  talentumStatus: 'QUALIFIED',
  workZone: 'Belgrano',
  redireccionamiento: null,
  acquisitionChannel: null,
  internalStage: 'QUALIFIED',
  contactNotesCount: 0,
};

async function installFakeFirebaseAuth(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          localId: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    }),
  );
}

async function setup(page: Page): Promise<{ moved: Record<string, unknown>[] }> {
  const captured: Record<string, unknown>[] = [];
  await installFakeFirebaseAuth(page);
  await mockAdminBaseRoutes(page);

  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (route: Route) => {
    const stages = emptyStages();
    stages.COMPLETED = [funnelCard];
    return route.fulfill(ok({ stages, totalEncuadres: 1 }));
  });

  await page.route(`**/api/admin/encuadres/${ENCUADRE_ID}/move`, (route: Route) => {
    if (route.request().method() === 'PUT') {
      captured.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill(ok({ encuadreId: ENCUADRE_ID, targetStage: 'CONFIRMED' }));
    }
    return route.continue();
  });

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });

  return { moved: captured };
}

async function abrirModalDeAgendamento(page: Page): Promise<void> {
  await page.addInitScript(
    ([key]) => window.localStorage.setItem(key, 'kanban'),
    [`vacancy-funnel-view-${VACANCY_ID}`],
  );
  await page.goto(`/admin/vacancies/${VACANCY_ID}`);
  await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });

  const card = page.locator(`[data-testid="kanban-card-${WJA_ID}"][data-stage]`).first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  await card.locator('[data-testid="move-to-button"]').click();
  await card.locator('[data-testid="move-to-option-CONFIRMED"]').click();
}

test.describe('Kanban — captura da data ao agendar', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('mover para "Agendados" pergunta QUANDO e envia data e hora', async ({ page }) => {
    const store = await setup(page);
    await abrirModalDeAgendamento(page);

    const modal = page.getByTestId('interview-schedule-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    await modal.screenshot({ path: 'e2e/__screenshots__/kanban-modal-agendamento.png' });

    // Nada foi movido ainda: o modal pergunta ANTES de gravar.
    expect(store.moved).toHaveLength(0);

    await page.getByTestId('interview-date-input').fill('2026-08-05');
    await page.getByTestId('interview-time-input').fill('14:30');
    await modal.screenshot({ path: 'e2e/__screenshots__/kanban-modal-agendamento-preenchido.png' });
    await page.getByTestId('interview-schedule-confirm').click();

    await expect.poll(() => store.moved.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(store.moved[0]).toMatchObject({
      targetStage: 'CONFIRMED',
      interviewDate: '2026-08-05',
      interviewTime: '14:30',
    });
  });

  test('"ainda não sei" move o card sem data — não bloqueia nem inventa horário', async ({ page }) => {
    const store = await setup(page);
    await abrirModalDeAgendamento(page);

    await expect(page.getByTestId('interview-schedule-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('interview-schedule-unknown').click();

    await expect.poll(() => store.moved.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(store.moved[0]).toMatchObject({ targetStage: 'CONFIRMED' });
    expect(store.moved[0].interviewDate).toBeUndefined();
    expect(store.moved[0].interviewTime).toBeUndefined();
  });
});
