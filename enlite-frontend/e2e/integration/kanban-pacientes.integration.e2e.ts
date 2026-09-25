/**
 * kanban-pacientes.integration.e2e.ts @integration
 *
 * Integration E2E — Kanban de pacientes (ciclo de vida). Frontend real +
 * backend real (Docker) + Postgres real, na MESMA estratégia de auth do
 * `admission-patient-flow.integration.e2e.ts`: Firebase mockado no Identity
 * Toolkit, `/api/**` trocado pelo token `mock_*` (backend em USE_MOCK_AUTH=true).
 *
 * Exercises (Fase 1 da change cadeia-paciente-vacante-itinerario):
 *   P9  — as 8 colunas do board, na ordem fixa
 *   P10 — o totalizador de cada coluna bate com a API
 *   P11 — paciente DISCHARGED (baja) não aparece em ACTIVE
 *   P12 — ALTA é manual e alcançável de qualquer coluna viva
 *   P13 — transição fora do catálogo é recusada e o toast diz o motivo
 */

import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { installAuthInterceptors, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

// DX-EX-1 (decisão desta execução): o molde (`admission-patient-flow`) tem
// BACKEND_URL fixo em 8080 porque o CI só roda no stack padrão. Esta stack é
// ISOLADA (8101, `cadeia-f1-postgres`) — fixar 8080 aqui bateria no backend
// errado. `E2E_BACKEND_URL` mantém o default 8080 para não quebrar o CI.
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_ADMIN_USER: MockUser = {
  uid: 'e2e-int-admin-kanban-pacientes',
  email: 'admin.kanban.pacientes@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_ADMIN_USER);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Gate revisao-pr (item 4a): interceptação movida para o helper compartilhado
// `abac-stack-helper.ts` (`installAuthInterceptors`/`tokenFor`) — cobre Identity
// Toolkit, securetoken, `/api/**` e `/v1/me/authz`/`/v1/me/simulation**`, igual
// ao que este arquivo duplicava inline. `/api/admin/auth/profile` continua
// mockado AQUI (registrado DEPOIS — Playwright prioriza o route mais recente):
// o helper deixa `/api/**` seguir para o backend REAL, que exige uma linha em
// `users` (e, em specs com engine ABAC, grupo/célula) para responder o profile —
// este teste não semeia `users`/grupo ABAC (fora do escopo deste gate), então a
// parte reaproveitada do helper é só a de INTERCEPTAÇÃO.
async function installInterceptors(page: Page): Promise<void> {
  await installAuthInterceptors(page, MOCK_ADMIN_USER);

  await page.route('**/api/admin/auth/profile', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          role: 'superadmin',
          firstName: 'Kanban',
          lastName: 'Pacientes',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    });
  });
}

/** Logs in via the admin login form with mocked Firebase Auth responses. */
async function loginAsAdmin(page: Page): Promise<void> {
  const email = MOCK_ADMIN_USER.email;
  const password = 'TestAdmin123!';

  await installInterceptors(page);

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();

  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/** GET /api/admin/patients/:id com o mesmo token mock — para conferir status pós-drop. */
async function fetchPatientStatus(
  request: APIRequestContext,
  patientId: string,
): Promise<string | null> {
  const res = await request.get(`${BACKEND_URL}/api/admin/patients/${patientId}`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  if (!res.ok()) throw new Error(`GET status ${res.status()}`);
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

const COLUMN_SELECTOR =
  '[data-testid^="kanban-column-"]:not([data-testid$="-count"]):not([data-testid$="-collapse"])';

async function waitForBoard(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="patient-kanban-board"]')).toBeVisible({ timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('kanban de pacientes @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  test.setTimeout(90_000);

  // ── P9 · as 8 colunas na ordem + o print ────────────────────────────────
  test('kanban-pacientes-oito-colunas', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/admin/patients/kanban');

    await waitForBoard(page);

    // Captura depois de waitForBoard: "primeiro passo depois da navegação" é depois de a tela existir,
    // não logo após o goto (que ainda mostra o esqueleto de loading).
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/kanban-pacientes.png`, fullPage: true });
    }

    // Segunda captura com o board rolado ao fim: em 1366 px cabem 4 colunas; alta e baja são as duas últimas.
    if (process.env.PRINT_DIR) {
      const board = page.locator('[data-testid="patient-kanban-board"]');
      await board.evaluate((n) => {
        n.scrollLeft = n.scrollWidth;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.PRINT_DIR}/kanban-pacientes-fim.png`, fullPage: true });
      await board.evaluate((n) => {
        n.scrollLeft = 0;
      });
    }

    const columnIds = await page.locator(COLUMN_SELECTOR).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')),
    );

    expect(columnIds).toEqual([
      'kanban-column-ADMISSION',
      'kanban-column-SEARCHING',
      'kanban-column-REPLACEMENT',
      'kanban-column-ACTIVE',
      'kanban-column-ON_HOLD',
      'kanban-column-SUSPENDED',
      'kanban-column-ALTA',
      'kanban-column-DISCHARGED',
    ]);

    // CLAUDE.md (Testes Visuais, obrigatório) — padrão dos 74 specs irmãos. Baseline darwin
    // commitada (53c4a091); o CI roda --ignore-snapshots.
    await expect(page).toHaveScreenshot('kanban-pacientes-oito-colunas.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
  });

  // ── P10 · o totalizador bate com a API ──────────────────────────────────
  test.describe('totalizador', () => {
    let activeId = '';
    let dischargedId = '';

    test.beforeAll(() => {
      activeId = insertTestPatient({
        status: 'ACTIVE',
        firstName: 'E2E',
        lastName: `Totalizador-Active-${Date.now()}`,
      }).patientId;
      dischargedId = insertTestPatient({
        status: 'DISCHARGED',
        firstName: 'E2E',
        lastName: `Totalizador-Discharged-${Date.now()}`,
      }).patientId;
    });

    test.afterAll(() => {
      cleanupTestPatient(activeId);
      cleanupTestPatient(dischargedId);
    });

    test('kanban-pacientes-totalizador', async ({ page, request }) => {
      const res = await request.get(`${BACKEND_URL}/api/admin/patients?limit=500&offset=0`, {
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { data: { status: string }[] };
      const nActive = body.data.filter((p) => p.status === 'ACTIVE').length;
      const nDischarged = body.data.filter((p) => p.status === 'DISCHARGED').length;

      await loginAsAdmin(page);
      await page.goto('/admin/patients/kanban');
      await waitForBoard(page);

      await expect(page.locator('[data-testid="kanban-column-ACTIVE-count"]')).toHaveText(String(nActive));
      await expect(page.locator('[data-testid="kanban-column-DISCHARGED-count"]')).toHaveText(String(nDischarged));
    });
  });

  // ── P11 · baja não aparece em activo ────────────────────────────────────
  test('kanban-pacientes-baja-fora-de-activo', async ({ page }) => {
    const lastName = `Baja-${Date.now()}`;
    const { patientId } = insertTestPatient({
      status: 'DISCHARGED',
      firstName: 'E2E',
      lastName,
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/admin/patients/kanban');
      await waitForBoard(page);

      await expect(page.locator('[data-testid="kanban-column-DISCHARGED"]')).toContainText(lastName);
      await expect(page.locator('[data-testid="kanban-column-ACTIVE"]')).not.toContainText(lastName);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  // ── P12 · alta é manual e vem de qualquer coluna viva ───────────────────
  test('kanban-pacientes-alta-manual', async ({ page, request }) => {
    test.setTimeout(180_000);

    const origins = ['SOLICITANTE', 'SEARCHING', 'REPLACEMENT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED'] as const;
    const seeded: string[] = [];
    const reached: string[] = [];

    try {
      await loginAsAdmin(page);

      for (const origin of origins) {
        const { patientId } = insertTestPatient({
          status: origin,
          firstName: 'E2E',
          lastName: `AltaManual-${origin}-${Date.now()}`,
        });
        seeded.push(patientId);

        await page.goto('/admin/patients/kanban');
        await waitForBoard(page);

        const card = page.locator(`[data-testid="patient-kanban-card-${patientId}"]`);
        await expect(card).toBeVisible({ timeout: 10_000 });
        const targetColumn = page.locator('[data-testid="kanban-column-ALTA"]');

        // DX-EX-3 (decisão desta execução, medida): com 8 colunas de 260px e
        // viewport 1366px, a coluna de origem de ON_HOLD/SUSPENDED (5ª/6ª) cai
        // na borda ou fora da área visível. `dndKitDrag` mede a posição do
        // CURSOR a partir do `boundingBox()` do source SEM garantir que ele
        // esteja em viewport — sem este scroll o drag nem inicia (sem toast,
        // sem request ao backend; medido isolando as duas origens: com
        // `scrollIntoViewIfNeeded()` antes, `status` vira ALTA; sem ele, fica
        // no status original). O helper (`e2e/helpers/dndKitDrag.ts`) não foi
        // tocado — só a chamada, aqui.
        await card.scrollIntoViewIfNeeded();
        // Item 4c (gate revisao-pr): espera o PUT /status disparado JUNTO com o drag —
        // sem isso a leitura pela API (linha abaixo) podia correr antes do backend
        // aplicar a mudança (corrida, não o resultado do drag).
        await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url())),
          dndKitDrag(page, card, targetColumn),
        ]);

        const status = await fetchPatientStatus(request, patientId);
        if (status === 'ALTA') reached.push(origin);
      }

      expect(reached).toEqual([...origins]);
    } finally {
      for (const id of seeded) cleanupTestPatient(id);
    }
  });

  // ── P13 · transição fora do catálogo é recusada e dita ──────────────────
  test('kanban-pacientes-transicao-recusada', async ({ page, request }) => {
    const lastName = `Recusada-${Date.now()}`;
    const { patientId } = insertTestPatient({
      status: 'SUSPENDED',
      firstName: 'E2E',
      lastName,
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/admin/patients/kanban');
      await waitForBoard(page);

      const card = page.locator(`[data-testid="patient-kanban-card-${patientId}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      const targetColumn = page.locator('[data-testid="kanban-column-SEARCHING"]');

      // DX-EX-3 (ver P12): SUSPENDED é a 6ª coluna — fora do viewport sem scroll.
      await card.scrollIntoViewIfNeeded();
      await dndKitDrag(page, card, targetColumn);

      await expect(page.getByText('Ese cambio de estado no está permitido.')).toBeVisible({ timeout: 8_000 });

      await expect(page.locator('[data-testid="kanban-column-SUSPENDED"]')).toContainText(lastName);

      const status = await fetchPatientStatus(request, patientId);
      expect(status).toBe('SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});

// ── Backend health check ───────────────────────────────────────────────────────

test.describe('Backend reachable for kanban de pacientes @integration', () => {
  test.setTimeout(10_000);

  test('backend returns healthy status', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.ok()).toBe(true);
  });
});
