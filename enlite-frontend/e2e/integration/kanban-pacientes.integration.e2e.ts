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
 *   P12 — ALTA é manual: a ação "Dar de alta" da ficha, de qualquer coluna viva (F5: o arrasto saiu)
 *   P13 — o gesto de arrastar não muda nada e o servidor recusa o estado derivado (PATIENT_STATUS_NOT_MANUAL)
 */

import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { installAuthInterceptors, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';

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

  await page.goto('/login?next=%2Fadmin');
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

  // ── P12 · alta é manual e vem de qualquer coluna viva (F5: pela ação "Dar de alta" da ficha — o arrasto saiu) ──
  test('kanban-pacientes-alta-manual', async ({ page, request }) => {
    test.setTimeout(240_000);

    // SOLICITANTE saiu da lista: a ficha só oferece ações a quem já passou pela admissão (o funil não tem "Dar de alta").
    const origins = ['SEARCHING', 'REPLACEMENT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED'] as const;
    const seeded: string[] = [];
    const reached: string[] = [];

    try {
      await loginAsAdmin(page);

      for (const origin of origins) {
        const { patientId } = insertTestPatient({
          status: origin,
          firstName: 'E2E',
          lastName: `AltaManual-${origin}-${Date.now()} QA`,
        });
        seeded.push(patientId);

        await page.goto(`/admin/patients/${patientId}`);
        const alta = page.getByTestId('patient-status-action-dar_alta');
        await alta.click({ timeout: 30_000 });
        if (origin === 'SUSPENDED') {
          // D444: sair de SUSPENDED por decisão humana pede o motivo de saída.
          await escolherNoCombo(page, page.getByTestId('patient-status-action-exit-reason'), 'Retomó el servicio (fin de vacaciones/internación)'); // RESUMED_SERVICE
          await page.getByTestId('patient-status-action-confirm').click();
        }
        await expect(page.getByTestId('patient-status-badge')).toContainText('Alta', { timeout: 20_000 }); // lido da TELA

        const status = await fetchPatientStatus(request, patientId);
        if (status === 'ALTA') reached.push(origin);

        // o Kanban lê o novo estado: o card está na coluna "Alta"
        await page.goto('/admin/patients/kanban');
        await waitForBoard(page);
        await expect(page.getByTestId('kanban-column-ALTA').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(1, { timeout: 15_000 });
      }

      expect(reached).toEqual([...origins]);
    } finally {
      for (const id of seeded) cleanupTestPatient(id);
    }
  });

  // ── P13 · F5: não há arrasto — o gesto não muda nada e o servidor recusa o estado derivado ──────────────
  // (antes: arrastar SEARCHING → SUSPENDED mostrava o toast "Este cambio de estado no está disponible"; o arrasto saiu e o toast com ele.)
  test('kanban-pacientes-transicao-recusada', async ({ page, request }) => {
    const stamp = Date.now();
    const lastName = `Recusada-${stamp} QA`;
    const { patientId } = insertTestPatient({
      status: 'SEARCHING',
      firstName: 'E2E',
      lastName,
    });

    try {
      const escritas: string[] = [];
      page.on('request', (r) => {
        if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(r.method());
      });
      await loginAsAdmin(page);
      await page.goto('/admin/patients/kanban');
      await waitForBoard(page);

      const card = page.locator(`[data-testid="patient-kanban-card-${patientId}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(`kanban-card-${patientId}`)).not.toHaveAttribute('aria-roledescription', /.+/);
      const targetColumn = page.locator('[data-testid="kanban-column-SUSPENDED"]');

      await card.scrollIntoViewIfNeeded();
      await dndKitDrag(page, card, targetColumn);

      // nenhuma escrita sai, nenhum toast de erro, e o card continua em Búsqueda
      expect(escritas).toEqual([]);
      await expect(page.getByText('Este cambio de estado no está disponible.')).toHaveCount(0);
      await expect(page.locator('[data-testid="kanban-column-SEARCHING"]')).toContainText(`Recusada-${stamp}`); // o card capitaliza o nome (" QA" → "Qa")

      // o servidor recusa o estado derivado (e a origem `kanban`) mesmo chamado direto
      for (const [status, changeSource] of [['ACTIVE', 'admin_panel'], ['REPLACEMENT', 'admin_panel'], ['SUSPENDED', 'kanban']]) {
        const res = await request.put(`${BACKEND_URL}/api/admin/patients/${patientId}/status`, {
          headers: { Authorization: `Bearer ${MOCK_TOKEN}`, 'Content-Type': 'application/json' },
          data: { status, changeSource },
        });
        expect(res.status(), `${changeSource} → ${status}`).toBe(422);
        expect(((await res.json()) as { code: string }).code).toBe('PATIENT_STATUS_NOT_MANUAL');
      }
      expect(await fetchPatientStatus(request, patientId)).toBe('SEARCHING');
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
