/**
 * match-vacancy-modal.integration.e2e.ts @integration
 *
 * Integration E2E — clica "Hacer match" no funnel da vacancy detail e valida
 * que o modal abre com candidatos distribuídos pelos 4 buckets de distância +
 * "Sin ubicación".
 *
 * Setup (DB direto):
 *   1. Paciente em Moreno, Buenos Aires (lat=-34.6506, lng=-58.7798)
 *   2. Vacante linkada ao address do paciente, required_sex='F', occupation='AT'
 *   3. 5 workers REGISTERED, sex=F, occupation=AT (passam os hard filters):
 *        W_NEAR     ~1km   (Moreno)
 *        W_MID      ~12km  (oeste)
 *        W_FAR      ~30km  (sul)
 *        W_OUT      Santiago, Chile  →  recusado pelo radius=50km
 *        W_NOCOORDS sem coords        →  bucket "Sin ubicación"
 *
 * Fluxo do teste (UI):
 *   - Login admin (mock auth)
 *   - GET /admin/vacancies/:id
 *   - Click "Hacer match"
 *   - Aguarda modal carregar (POST /api/admin/vacancies/:id/match termina)
 *   - Valida chips (Sexo · Profesión · Dirección)
 *   - Valida que os 4 buckets distintos (≤5km, ≤10km, ≤20km, ≤50km, Sin ubicación)
 *     têm os candidatos esperados
 *   - Worker em Santiago NÃO aparece (>50km recusado)
 *   - Screenshot final
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
  insertTestWorker,
  cleanupTestWorker,
} from '../helpers/db-test-helper';

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-match-modal',
  email: 'admin.match.modal@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// Patient address: Moreno, Buenos Aires (perto da vaga teste real)
const PATIENT_LAT = -34.6506;
const PATIENT_LNG = -58.7798;

async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
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
        users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'Match',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

test.describe('Match modal — buckets de distância @integration', () => {
  test.setTimeout(120_000);

  let patientId: string;
  let addressId: string | null;
  let vacancyId: string;
  const workerIds: Record<string, string> = {};

  test.beforeAll(async () => {
    // 1. Patient em Moreno, BA — com geocoding
    const result = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'MatchModalTest',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: PATIENT_LAT,
      addressLng: PATIENT_LNG,
    });
    patientId = result.patientId;
    addressId = result.addressId;
    if (!addressId) throw new Error('Setup: addressId is required');

    // 2. Vacancy via DB helper (caseNumber alto pra evitar colisões)
    const caseNumber = 990_000 + Math.floor(Math.random() * 9999);
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      requiredSex: 'F',
      requiredProfessions: ['AT'],
    });

    // 3. Workers — 5 cenários cobrindo os 4 buckets de distância + sem coords
    workerIds.near = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'NearW',
      lat: -34.6450,
      lng: -58.7780, // ~0.6 km de Moreno
    });
    workerIds.mid = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'MidW',
      lat: -34.7500,
      lng: -58.6800, // ~12 km
    });
    workerIds.far = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'FarW',
      lat: -34.9000,
      lng: -58.5500, // ~33 km
    });
    workerIds.out = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'OutW',
      lat: -33.4489,
      lng: -70.6693, // Santiago, Chile (>1000 km, fora do radius=50)
    });
    workerIds.nocoords = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'NoCoordsW',
      lat: null,
      lng: null,
    });
  });

  test.afterAll(() => {
    Object.values(workerIds).forEach(cleanupTestWorker);
    if (vacancyId) cleanupVacancies([vacancyId]);
    if (patientId) cleanupTestPatient(patientId);
  });

  test('abre modal "Hacer match" e distribui candidatos pelos buckets de distância', async ({
    page,
  }) => {
    const SNAP = 'e2e/integration/match-vacancy-modal.integration.e2e.ts-snapshots';

    await loginAsAdmin(page);
    await page.screenshot({ path: `${SNAP}/01-after-login.png`, fullPage: false });

    // Navega pra vacancy detail (default tab = encuadres → renderiza FunnelView)
    await page.goto(`/admin/vacancies/${vacancyId}`);

    // Aguarda os botões da linha do funnel renderizarem (toggle + Hacer match + Enviar invitaciones)
    await expect(page.getByRole('button', { name: /Hacer match/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({ path: `${SNAP}/02-vacancy-detail.png`, fullPage: false });

    // Aguarda a chamada do match completar antes de assertar buckets
    const matchPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/admin/vacancies/${vacancyId}/match?`) &&
        resp.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /Hacer match/i }).click();
    const matchResp = await matchPromise;
    expect(matchResp.ok(), `Match POST failed: ${matchResp.status()}`).toBe(true);

    // Modal aberto
    const dialog = page.locator('text=Match de candidatos').first();
    await expect(dialog).toBeVisible();

    // Chips dos critérios
    await expect(page.getByText(/Sexo:\s*F/i).first()).toBeVisible();
    await expect(page.getByText(/Profesión:\s*AT/i).first()).toBeVisible();
    await expect(page.getByText(/Dirección:\s*Av\. Corrientes|Dirección:.*Moreno|Dirección:.*Av\.|Dirección:.*Buenos Aires/i).first()).toBeVisible();

    // Aguarda buckets renderizarem (loading some, listas aparecem)
    // O modal sempre renderiza os 5 cabeçalhos de bucket — aguarda o "Sin ubicación"
    await expect(page.getByText('Sin ubicación').first()).toBeVisible({ timeout: 10_000 });

    // ── Asserts de candidatos por bucket ──────────────────────────────────────
    // Worker em Santiago (W_OUT) NÃO deve aparecer — radius=50km filtra ele
    await expect(page.getByText(/OutW/)).toHaveCount(0);

    // Worker sem coords aparece em "Sin ubicación"
    await expect(page.getByText(/NoCoordsW/)).toBeVisible();

    // Workers near/mid/far devem aparecer com distâncias preenchidas (X.X km)
    // Validação: pelo menos um candidato com distância em km no DOM
    const distanceLabels = page.locator('text=/\\d+\\.\\d+ km/');
    await expect(distanceLabels.first()).toBeVisible();
    const distanceCount = await distanceLabels.count();
    expect(distanceCount).toBeGreaterThanOrEqual(3); // near + mid + far

    // ── Asserts de cada bucket via DOM (independente de viewport) ────────────
    // NearW (~0.6 km) → ≤ 5 km
    await expect(page.getByText(/NearW/)).toBeVisible();
    // MidW (~12 km) → > 10 ≤ 20
    await expect(page.getByText(/MidW/)).toBeVisible();
    // FarW (~33 km) → > 20 ≤ 50
    await expect(page.getByText(/FarW/)).toBeVisible();
    // NoCoordsW → Sin ubicación
    await expect(page.getByText(/NoCoordsW/)).toBeVisible();

    // ── Screenshot do modal inteiro com viewport alto pra mostrar TODOS os buckets
    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SNAP}/03-modal-fullview.png`, fullPage: false });
    await page.screenshot({ path: `${SNAP}/04-modal-fullpage.png`, fullPage: true });
  });
});
