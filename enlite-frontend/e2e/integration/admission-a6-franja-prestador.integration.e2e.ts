/**
 * admission-a6-franja-prestador.integration.e2e.ts @integration — spec 015 (US-A6.1/US-A6.2).
 *
 * Front real (Vite 5173) + API real (docker enlite-api, rebuildada desta worktree) + Postgres
 * real (migration 322). Auth REAL pelo emulador do Firebase. Zero mock de dado. Só dado
 * sintético. Molde: admission-c-servico-contratado.integration.e2e.ts.
 *
 * Aceite: cria serviço com franja "30 a 45 años" no drawer → card mostra o rótulo → ativa
 * (sincroniza pela RESPOSTA do POST) → lê no Postgres `age_range_min=30, age_range_max=44` na
 * vaga NASCIDA DESTE SERVIÇO.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  seedActivatablePatientA6, readVacancyAgeRangeForService, readProviderAgeBand,
  cleanupPatientDeep, runSQL,
} from '../helpers/patient-detail-a6-helper';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.a6.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

async function loginAsRealStaff(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E A6', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await forceClick(page.getByRole('button', { name: /Iniciar sesi/i }));
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/** Molde do bloco C: o banner do emulador intercepta clique — remove do DOM via MutationObserver. */
async function forceClick(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: HTMLElement) => el.click());
}

async function forceSelect(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.selectOption(value);
}

async function openDetail(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) return;
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Spec 015 (US-A6) — franja etária solicitada do prestador @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };

  test.beforeAll(() => {
    seed = seedActivatablePatientA6();
  });

  test.afterAll(() => {
    cleanupPatientDeep(seed.patientId);
  });

  test('1. escolhe franja "30 a 45 años" no drawer → card mostra o rótulo → ativa → vaga do serviço com age_range_min=30/max=44', async ({ page }) => {
    await page.addInitScript(() => {
      const strip = () => {
        document.querySelectorAll('.firebase-emulator-warning').forEach((el) => el.remove());
      };
      strip();
      new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true });
    });
    await loginAsRealStaff(page);
    await openDetail(page, seed.patientId);

    await forceClick(page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }));
    await expect(page.getByTestId('servicos-contratados-card')).toBeVisible();

    // ── Abre o drawer, cria o serviço com a franja "30 a 45 años" ──
    await forceClick(page.getByTestId('new-service-btn'));
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();
    await forceSelect(page.getByTestId('svc-code-1'), 'AT');
    await forceSelect(page.getByTestId('svc-providerAgeBand-1'), 'AGE_30_45');
    // Migration 330: sem endereço vinculado o activate recusa (SERVICE_ADDRESS).
    await forceSelect(page.getByTestId('svc-addressId-1'), seed.addressId);
    // Decisão do Gabriel 07/09: sem horário o activate também recusa (SERVICE_SCHEDULE) — este
    // spec ativa mais abaixo esperando 200, então o serviço nasce com horário.
    await forceClick(page.getByTestId('day-schedule-add-monday'));
    const createService = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contracted-services$/.test(r.url()));
    await forceClick(page.getByTestId('contracted-service-new-save'));
    const svcBody = (await (await createService).json()) as { data: { id: string; providerAgeBand: string } };
    const serviceId = svcBody.data.id;
    expect(svcBody.data.providerAgeBand).toBe('AGE_30_45');
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });

    // ── Fecha o drawer, o card mostra o rótulo traduzido (nunca o enum cru) ──
    await forceClick(page.getByLabel('Cerrar'));
    await page.waitForTimeout(400);
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();
    // 05/09: a franja saiu da tabela (5 colunas do Figma) e vive no DETALHE — clique na linha.
    await expect(page.locator('[data-testid="servicos-contratados-card"]')).toHaveScreenshot('a6-franja-card.png');
    await forceClick(page.getByTestId(`contracted-service-row-${serviceId}`));
    const ageBandCell = page.getByTestId('svc-detail-age-band');
    await expect(ageBandCell).toContainText('30 a 45 Años');
    await expect(ageBandCell).not.toHaveText(/AGE_30_45/);
    await forceClick(page.getByTestId('contracted-service-detail-close'));
    await page.waitForTimeout(400);
    await expect(page.getByTestId('contracted-service-detail-drawer')).not.toBeVisible();

    // ── Ativar recrutamento DO SERVIÇO (spec 018, PR-6, ADR-5): sincroniza pela RESPOSTA do
    //    POST /activate-recruitment (molde do bloco C, D-lição do brief) ──
    const activated = page.waitForResponse((r) => r.request().method() === 'POST' && /\/activate-recruitment$/.test(r.url()), { timeout: 30_000 });
    await forceClick(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`));
    expect((await activated).status()).toBe(201);
    await expect(page.getByTestId(`contracted-service-view-vacancy-${serviceId}`)).toBeVisible({ timeout: 15_000 });

    // ── Prova no Postgres: só a vaga NASCIDA DO SERVIÇO herda a franja ──
    expect(readProviderAgeBand(serviceId)).toBe('AGE_30_45');
    const range = readVacancyAgeRangeForService(seed.patientId, serviceId);
    expect(range).not.toBeNull();
    expect(range?.ageRangeMin).toBe(30);
    expect(range?.ageRangeMax).toBe(44);
  });
});
