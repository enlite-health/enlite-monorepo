/**
 * match-worker-profile-modal-visual.e2e.ts
 *
 * Visual E2E — Modal de perfil do prestador aberto a partir da lista de match,
 * incluindo o checkbox "Conta de prueba" visível apenas para admin.
 *
 * Rota: /admin/vacancies/:id/match → clicar no ícone "ver perfil" da linha.
 *
 * Objetivo: provar via screenshot determinístico (toHaveScreenshot) que:
 *   1. O modal de perfil abre read-only com os cards do prestador.
 *   2. O checkbox de conta de teste aparece para role=admin.
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador, sem
 * conta real — emulador é banido neste projeto). Técnica idêntica à de
 * blocked-attempts-visual.e2e.ts. role=admin é obrigatório para o checkbox.
 *
 * Todos os endpoints são mockados — zero dependência de dados reais.
 *
 * Run: pnpm test:e2e:no-integration --update-snapshots (1ª vez)
 *      pnpm test:e2e:no-integration (subsequentes)
 */

import { test, expect, Page, Route } from '@playwright/test';

// ── Auth constants (role=admin para o checkbox renderizar) ────────────────────

const MOCK_ADMIN = {
  uid: 'match-modal-vis-admin-uid',
  email: 'match.modal.visual@e2e.test',
  role: 'admin',
};

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

// ── Deterministic fixture IDs ─────────────────────────────────────────────────

const VACANCY_ID = 'bbbbbbbb-mm01-mm01-mm01-000000000001';
const WORKER_ID = 'aaaaaaaa-mm01-mm01-mm01-000000000001';

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 77001,
  title: 'Caso 77001 — modal visual proof',
  status: 'BUSQUEDA',
  patient_zone: 'Palermo',
  required_professions: ['AT'],
};

const MOCK_MATCH_RESULTS = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    lastMatchAt: '2026-06-18T12:00:00Z',
    totalCandidates: 1,
    candidates: [
      {
        workerId: WORKER_ID,
        workerName: 'Sofía Martínez',
        workerPhone: '+5491100000091',
        occupation: 'Acompañante Terapéutico',
        workZone: 'Palermo',
        distanceKm: 1.8,
        activeCasesCount: 0,
        overallStatus: 'QUALIFICADO',
        documentStatus: 'all_validated',
        matchScore: 92,
        internalNotes: null,
        alreadyApplied: false,
        messagedAt: null,
      },
    ],
  },
};

const MOCK_WORKER_DETAIL = {
  success: true,
  data: {
    id: WORKER_ID,
    email: 'sofia.martinez@e2e.test',
    phone: '+5491100000091',
    whatsappPhone: '+5491100000091',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED',
    overallStatus: 'QUALIFICADO',
    availabilityStatus: 'available',
    dataSources: ['talentum'],
    platform: 'talentum',
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    firstName: 'Sofía',
    lastName: 'Martínez',
    sex: 'female',
    gender: 'female',
    birthDate: '1992-04-12',
    documentType: 'DNI',
    documentNumber: '30.111.222',
    profilePhotoUrl: null,
    profession: 'AT',
    occupation: 'Acompañante Terapéutico',
    knowledgeLevel: 'UNIVERSITY',
    titleCertificate: 'Tecnicatura AT',
    experienceTypes: ['TEA'],
    yearsExperience: '5_10',
    preferredTypes: ['home'],
    preferredAgeRange: ['children'],
    languages: ['es'],
    sexualOrientation: null,
    race: null,
    religion: null,
    weightKg: null,
    heightCm: null,
    hobbies: [],
    diagnosticPreferences: [],
    linkedinUrl: null,
    isMatchable: true,
    isActive: true,
    isTest: false,
    documents: null,
    serviceAreas: [],
    location: { address: 'Palermo, CABA', city: 'CABA', workZone: 'Palermo', interestZone: null },
    encuadres: [],
    availability: [],
    tags: [],
  },
};

// ── Auth helper (no emulator, no real Firebase) ───────────────────────────────

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
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id_token: FAKE_ID_TOKEN,
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
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

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    });
  });

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, role: MOCK_ADMIN.role,
          firstName: 'Visual', lastName: 'E2E', isActive: true, mustChangePassword: false,
        },
      }),
    }),
  );
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installFakeFirebaseAuth(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Data mocks ────────────────────────────────────────────────────────────────

async function setupDataMocks(page: Page): Promise<void> {
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MATCH_RESULTS) }),
  );
  // triggerMatch — POST /match?... (Promise.all com getMatchResults no hook)
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match?**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MATCH_RESULTS) }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MATCH_RESULTS) }),
  );
  await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
  );
  // worker detail (must come after the more specific additional-documents route)
  await page.route(`**/api/admin/workers/${WORKER_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_WORKER_DETAIL) }),
  );
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe('Match — worker profile modal (admin)', () => {
  test.setTimeout(60000);

  test('opens the worker profile modal with the admin test-account checkbox', async ({ page }) => {
    await loginAsAdmin(page);
    await setupDataMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match?lng=es`);
    await expect(page.locator('text=Sofía Martínez').first()).toBeVisible({ timeout: 15000 });

    // Abre o modal via ícone "ver perfil"
    await page.getByTestId('match-view-profile').first().click();

    const modal = page.getByTestId('worker-profile-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // O checkbox de conta de teste deve estar presente (role=admin)
    const checkbox = page.getByTestId('worker-test-account-checkbox');
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    await expect(checkbox).not.toBeChecked();

    // Screenshot determinístico do modal aberto (inclui o checkbox admin)
    await expect(modal).toHaveScreenshot('worker-profile-modal-admin.png', {
      maxDiffPixelRatio: 0.02,
    });

    // Screenshot focado no bloco do checkbox no estado admin
    await expect(page.getByTestId('worker-test-account-checkbox').locator('xpath=ancestor::label')).toHaveScreenshot(
      'worker-test-account-checkbox-admin.png',
      { maxDiffPixelRatio: 0.02 },
    );
  });
});
