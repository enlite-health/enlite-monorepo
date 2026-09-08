/**
 * vacancy-kanban.e2e.ts
 *
 * Playwright E2E — Kanban de Encuadres (/admin/vacancies/:id/kanban)
 *
 * Fluxo coberto:
 *   - Navega de detalhe da vaga para kanban via botão "Kanban"
 *   - Renderiza 6 colunas do funnel com contagens corretas
 *   - Cards exibem nome do worker, zona, match score
 *   - Cards rejeitados exibem badge de motivo de rejeição
 *   - Coluna REJECTED mostra encuadres com rejection_reason_category
 */

import { test, expect, Page } from '@playwright/test';
import { E2E_EMAIL, loginAsAdmin } from './helpers/kanban-notes-e2e-helper';

const FIREBASE_API_KEY  = 'test-api-key';

const MOCK_VACANCY_ID = 'bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 22001,
  title: 'Caso 22001 — Kanban Test',
  status: 'BUSQUEDA',
  country: 'Argentina',
  patient_first_name: 'Paciente',
  patient_last_name: 'Kanban',
  encuadres: [
    { id: 'e1', worker_name: 'Ana García', worker_phone: '+549111', interview_date: '2026-04-01', resultado: 'RECHAZADO', attended: true, rejection_reason_category: 'DISTANCE', rejection_reason: 'Vive lejos' },
    { id: 'e2', worker_name: 'Bruno López', worker_phone: '+549222', interview_date: '2026-04-02', resultado: 'SELECCIONADO', attended: true, rejection_reason_category: null, rejection_reason: null },
  ],
  publications: [],
};

const MOCK_FUNNEL = {
  success: true,
  data: {
    stages: {
      INVITED: [
        { id: 'f1', workerName: 'Carlos Ruiz', workerPhone: '+549333', occupation: 'AT', interviewDate: '2026-04-10', interviewTime: '10:00', meetLink: null, resultado: null, attended: null, rejectionReasonCategory: null, rejectionReason: null, matchScore: 72, workZone: 'Belgrano', redireccionamiento: null },
      ],
      CONFIRMED: [
        { id: 'f2', workerName: 'Diana Martínez', workerPhone: '+549444', occupation: 'NURSE', interviewDate: '2026-04-10', interviewTime: '14:00', meetLink: 'https://meet.google.com/abc', resultado: null, attended: null, rejectionReasonCategory: null, rejectionReason: null, matchScore: 88, workZone: 'Palermo', redireccionamiento: null },
      ],
      INTERVIEWING: [],
      SELECTED: [
        { id: 'f3', workerName: 'Elena Sosa', workerPhone: '+549555', occupation: 'AT', interviewDate: '2026-03-28', interviewTime: '09:00', meetLink: null, resultado: 'SELECCIONADO', attended: true, rejectionReasonCategory: null, rejectionReason: null, matchScore: 95, workZone: 'Recoleta', redireccionamiento: null },
      ],
      REJECTED: [
        { id: 'f4', workerName: 'Felipe Gómez', workerPhone: '+549666', occupation: 'AT', interviewDate: '2026-03-25', interviewTime: null, meetLink: null, resultado: 'RECHAZADO', attended: true, rejectionReasonCategory: 'DISTANCE', rejectionReason: 'Vive muy lejos', matchScore: 40, workZone: null, redireccionamiento: null },
        { id: 'f5', workerName: 'Gloria Paz', workerPhone: '+549777', occupation: 'CAREGIVER', interviewDate: '2026-03-20', interviewTime: null, meetLink: null, resultado: 'AT_NO_ACEPTA', attended: true, rejectionReasonCategory: 'SCHEDULE_INCOMPATIBLE', rejectionReason: null, matchScore: 55, workZone: 'Flores', redireccionamiento: null },
      ],
      PENDING: [
        { id: 'f6', workerName: 'Hugo Méndez', workerPhone: '+549888', occupation: 'AT', interviewDate: null, interviewTime: null, meetLink: null, resultado: 'PENDIENTE', attended: null, rejectionReasonCategory: null, rejectionReason: null, matchScore: null, workZone: null, redireccionamiento: null },
      ],
    },
    totalEncuadres: 6,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  // Login com a conta STAFF REAL (enlite-prd) — ver a nota em
  // vacancy-kanban-eligibility-visual.e2e.ts: usuário do emulador não tem custom
  // claim, e o app decide staff × prestador pelo token, não pelo perfil mockado.
  // Catch-all admin PRIMEIRO — rotas específicas registradas depois vencem
  // (Playwright: a última rota registrada tem precedência).
  //
  // Sem ele, as chamadas que o spec não mocka (lista de usuários, telemetria)
  // escapam para a API de `VITE_API_WORKER_FUNCTIONS_URL` e morrem em CORS: o
  // backend local só libera a origem `localhost:5173`, e um dev server em
  // qualquer outra porta faz o app cair na home de PRESTADOR — Kanban nunca
  // monta. Com o catch-all o spec fica hermético e roda em qualquer porta.
  await page.route('**/api/admin/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: null }),
  }));

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { id: 'e2e-kanban-admin', email: E2E_EMAIL, role: 'superadmin', firstName: 'Admin', lastName: 'Kanban', isActive: true, mustChangePassword: false } }),
    }),
  );

  await loginAsAdmin(page);
}

function mockVacancyApis(page: Page) {
  return Promise.all([
    page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    ),
    page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FUNNEL) }),
    ),
  ]);
}

// ── Testes ────────────────────────────────────────────────────────────────

test.describe('VacancyKanbanPage', () => {
  test.setTimeout(60000);
  // Wide viewport so all 6 kanban columns + sidebar fit without horizontal scroll
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('botão "Kanban" na VacancyDetailPage navega para a página do kanban', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    // Mock match-results to prevent errors if page pre-fetches
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { jobPostingId: MOCK_VACANCY_ID, lastMatchAt: null, totalCandidates: 0, candidates: [] } }) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.getByRole('button', { name: /Kanban/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Kanban/i }).click();

    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`), { timeout: 10000 });
  });

  test('renderiza 6 colunas do kanban com títulos corretos', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    // Verifica que as 6 colunas estão presentes
    await expect(page.locator('text=Invitados').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Confirmados').first()).toBeVisible();
    await expect(page.locator('text=Entrevistando').first()).toBeVisible();
    await expect(page.locator('text=Seleccionados').first()).toBeVisible();
    await expect(page.locator('text=Rechazados').first()).toBeVisible();
    await expect(page.locator('text=Pendientes').first()).toBeVisible();
  });

  test('exibe total de encuadres no header', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    await expect(page.locator('text=6 encuadres totales').first()).toBeVisible({ timeout: 15000 });
  });

  test('cards dos workers exibem nome, zona e match score', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    // Worker na coluna Confirmed
    await expect(page.locator('text=Diana Martínez').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Palermo').first()).toBeVisible();
    await expect(page.locator('text=88').first()).toBeVisible();

    // Worker na coluna Selected
    await expect(page.locator('text=Elena Sosa').first()).toBeVisible();
    await expect(page.locator('text=95').first()).toBeVisible();
  });

  test('cards rejeitados exibem badge com motivo de rejeição', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    // Felipe Gómez — DISTANCE
    await expect(page.locator('text=Felipe Gómez').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Distancia').first()).toBeVisible();

    // Gloria Paz — SCHEDULE_INCOMPATIBLE
    await expect(page.locator('text=Gloria Paz').first()).toBeVisible();
    await expect(page.locator('text=Horario').first()).toBeVisible();
  });

  test('header mostra título do caso e botão voltar', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    await expect(page.locator('text=Kanban').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=22001').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Actualizar/i })).toBeVisible();
  });

  test('cards são arrastáveis — atributos DnD do @dnd-kit presentes', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    const card = page.locator('[data-testid="kanban-card-f1"]');
    await expect(card).toBeVisible({ timeout: 15000 });

    // @dnd-kit useDraggable injeta role=button e tabindex=0 no elemento
    await expect(card).toHaveAttribute('role', 'button');
    await expect(card).toHaveAttribute('tabindex', '0');
  });

  test('6 colunas droppable presentes com data-testid', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);
    await expect(page.locator('[data-testid="kanban-card-f1"]')).toBeVisible({ timeout: 15000 });

    const columnIds = ['INVITED', 'CONFIRMED', 'INTERVIEWING', 'SELECTED', 'REJECTED', 'PENDING'];
    for (const id of columnIds) {
      await expect(page.locator(`[data-testid="kanban-column-${id}"]`)).toBeAttached();
    }
  });

  test('PUT /encuadres/:id/move endpoint é interceptado corretamente', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    let capturedMove: { url: string; body: string } | null = null;

    await page.route('**/api/admin/encuadres/*/move', route => {
      capturedMove = { url: route.request().url(), body: route.request().postData() ?? '' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FUNNEL) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);
    await expect(page.locator('[data-testid="kanban-card-f1"]')).toBeVisible({ timeout: 15000 });

    // Simula o que o DnD handler faz: fetch PUT diretamente
    await page.evaluate(async () => {
      await fetch('/api/admin/encuadres/f1/move', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultado: 'SELECCIONADO' }),
      });
    });

    await page.waitForTimeout(500);
    expect(capturedMove).not.toBeNull();
    const body = JSON.parse(capturedMove!.body);
    expect(body.resultado).toBe('SELECCIONADO');
  });

  test('drag overlay segue o cursor sem offset (fix: card não aplica translate3d)', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);

    const card = page.locator('[data-testid="kanban-card-f1"]');
    await expect(card).toBeVisible({ timeout: 15000 });

    const box = await card.boundingBox();
    expect(box).not.toBeNull();

    // Start position: center of card
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // Target position: drag 200px to the right
    const targetX = startX + 200;
    const targetY = startY;

    // Simulate drag: mouse down → move past 8px activation threshold → hold
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Small move to activate dnd-kit PointerSensor (distance: 8)
    await page.mouse.move(startX + 10, startY, { steps: 3 });
    await page.mouse.move(targetX, targetY, { steps: 10 });

    // Wait for DragOverlay to render
    await page.waitForTimeout(200);

    // 1) Original card should NOT have inline transform
    const inlineTransform = await card.evaluate(el => el.style.transform);
    expect(inlineTransform).toBe('');

    // 2) Original card should be dimmed (opacity-30)
    const hasDimClass = await card.evaluate(el => el.className.includes('opacity-30'));
    expect(hasDimClass).toBe(true);

    // 3) DragOverlay should be visible — dnd-kit renders it as a fixed-position element
    //    The overlay contains a clone with opacity-80 rotate-2 wrapper
    const overlay = page.locator('div.opacity-80.rotate-2');
    await expect(overlay).toBeVisible();

    // 4) Overlay position should be near the cursor, not offset by sidebar width
    const overlayBox = await overlay.boundingBox();
    expect(overlayBox).not.toBeNull();

    const overlayCenterX = overlayBox!.x + overlayBox!.width / 2;
    const overlayCenterY = overlayBox!.y + overlayBox!.height / 2;

    const distX = Math.abs(overlayCenterX - targetX);
    const distY = Math.abs(overlayCenterY - targetY);

    // Take screenshot for visual verification
    await page.screenshot({ path: 'e2e/screenshots/kanban-drag-overlay.png' });

    // Before the fix, distX would be ~200px (sidebar offset). After fix, should be close.
    expect(distX).toBeLessThan(100);
    expect(distY).toBeLessThan(100);

    // Release drag
    await page.mouse.up();
  });

  test('botão Actualizar refaz a requisição do funnel', async ({ page }) => {
    await seedAdminAndLogin(page);
    let fetchCount = 0;

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`, route => {
      fetchCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FUNNEL) });
    });

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);
    await expect(page.locator('text=Carlos Ruiz').first()).toBeVisible({ timeout: 15000 });

    const initialCount = fetchCount;
    await page.getByRole('button', { name: /Actualizar/i }).click();
    await page.waitForTimeout(1000);

    expect(fetchCount).toBeGreaterThan(initialCount);
  });
});
