/**
 * interview-scheduling.e2e.ts
 *
 * Playwright E2E — Agendamento de Entrevistas (/admin/vacancies/:id/match)
 * Wave 2 — Agendamento de Entrevistas + Lembretes WhatsApp
 *
 * Fluxo coberto:
 *   - Botão "Agendar Entrevista" visível apenas quando candidatos selecionados
 *   - Modal abre com formulário de configuração de slots (Fase 1)
 *   - Criação de slots dispara POST /interview-slots
 *   - Fase 2 exibe candidatos com select de slot disponível
 *   - Agendamento individual dispara POST /interview-slots/:id/book
 *   - Slot lotado exibe opção "Nenhum slot disponível"
 *   - Botão "Listo" fecha o modal e limpa seleção
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

const VACANCY_ID = 'dddddddd-0002-0002-0002-dddddddddddd';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 44001,
  title: 'Caso 44001 — Interview Scheduling E2E',
  status: 'BUSQUEDA',
  patient_zone: 'Palermo',
  required_professions: ['AT'],
};

const MOCK_CANDIDATES = [
  {
    workerId:        'worker-sched-001',
    workerName:      'Laura Fernández',
    workerPhone:     '+5491100000011',
    occupation:      'Acompañante Terapéutico',
    workZone:        'Palermo',
    distanceKm:      2.1,
    activeCasesCount: 0,
    overallStatus:   'QUALIFICADO',
    matchScore:      90,
    internalNotes:   null,
    alreadyApplied:  false,
    messagedAt:      null,
  },
  {
    workerId:        'worker-sched-002',
    workerName:      'Marcos Oliveira',
    workerPhone:     '+5491100000022',
    occupation:      'Enfermero',
    workZone:        'Caballito',
    distanceKm:      3.5,
    activeCasesCount: 0,
    overallStatus:   'QUALIFICADO',
    matchScore:      78,
    internalNotes:   null,
    alreadyApplied:  false,
    messagedAt:      null,
  },
];

const POPULATED_MATCH = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    lastMatchAt:  '2026-03-28T10:00:00Z',
    totalCandidates: 2,
    candidates: MOCK_CANDIDATES,
  },
};

const MOCK_SLOT = {
  id: 'slot-aaa-001',
  coordinatorId: null,
  jobPostingId: VACANCY_ID,
  slotDate: '2026-04-10',
  slotTime: '10:00',
  slotEndTime: '10:30',
  meetLink: 'https://meet.google.com/test-link',
  maxCapacity: 1,
  bookedCount: 0,
  status: 'AVAILABLE',
  notes: null,
  createdAt: '2026-03-28T10:00:00Z',
  updatedAt: '2026-03-28T10:00:00Z',
};

const MOCK_SLOTS_RESPONSE = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    slots: [MOCK_SLOT],
    summary: { total: 1, available: 1, full: 0, cancelled: 0 },
  },
};

const EMPTY_SLOTS_RESPONSE = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    slots: [],
    summary: { total: 0, available: 0, full: 0, cancelled: 0 },
  },
};

const FULL_SLOT = { ...MOCK_SLOT, id: 'slot-full-001', bookedCount: 1, status: 'FULL' };
const FULL_SLOTS_RESPONSE = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    slots: [FULL_SLOT],
    summary: { total: 1, available: 0, full: 1, cancelled: 0 },
  },
};

const BOOK_SUCCESS = {
  success: true,
  data: {
    encuadreId: 'worker-sched-001',
    slotId: 'slot-aaa-001',
    interviewDate: '2026-04-10',
    interviewTime: '10:00',
    meetLink: 'https://meet.google.com/test-link',
    invitationQueued: true,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email    = `e2e.schedule.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: uid, email, role: 'superadmin', firstName: 'Admin', lastName: 'Sched', isActive: true, mustChangePassword: false },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function setupMatchPageMocks(page: Page, slotsResponse = EMPTY_SLOTS_RESPONSE) {
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
  );
  // Mock GET /match-results AND POST /match — useVacancyMatch calls both in Promise.all on mount
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(slotsResponse) }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────

test.describe('InterviewScheduling — VacancyMatchPage', () => {
  test.setTimeout(60000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('botão "Agendar Entrevista" NÃO aparece sem candidatos selecionados', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    // Sem seleção, o botão não deve existir
    await expect(page.getByRole('button', { name: /Agendar Entrevista/i })).not.toBeVisible();
  });

  test('botão "Agendar Entrevista" aparece quando há candidatos selecionados', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    // Seleciona Laura
    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();

    // Botão deve aparecer
    await expect(page.getByRole('button', { name: /Agendar Entrevista/i })).toBeVisible({ timeout: 5000 });
  });

  test('modal abre com formulário de configuração de slots (Fase 1)', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    // Modal deve aparecer com título de fase 1
    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });
    // Formulário com campos obrigatórios
    await expect(page.locator('label', { hasText: /Fecha de entrevistas/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Hora de inicio/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Duración/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Link Meet/i }).first()).toBeVisible();
  });

  test('criação de slots dispara POST /interview-slots e avança para fase 2', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Primeira chamada GET retorna vazio (antes de criar), segunda retorna com slot
    let getCallCount = 0;
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route => {
      getCallCount++;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(getCallCount <= 1 ? EMPTY_SLOTS_RESPONSE : MOCK_SLOTS_RESPONSE),
      });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route('**/api/admin/messaging/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
    );

    let capturedCreateBody: unknown = null;
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots`, route => {
      if (route.request().method() === 'POST') {
        capturedCreateBody = route.request().postData();
        return route.fulfill({
          status: 201, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [MOCK_SLOT] }),
        });
      }
      return route.continue();
    });

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });

    // Preenche o formulário
    await page.locator('input[type="date"]').fill('2026-04-10');
    await page.getByRole('button', { name: /Crear Slots/i }).click();

    // Deve ter disparado o POST
    await page.waitForTimeout(1000);
    expect(capturedCreateBody).not.toBeNull();

    // Deve avançar para fase 2
    await expect(page.locator('text=/Agendar Candidatos/i').first()).toBeVisible({ timeout: 5000 });
  });

  test('fase 2 exibe candidatos selecionados com slot disponível', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Simula que já há slots criados: GET retorna slots direto
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SLOTS_RESPONSE) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: [MOCK_SLOT] }) });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route('**/api/admin/messaging/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    // Seleciona os dois candidatos
    await page.locator('thead input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    // Vai para fase 1 e cria slots
    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });
    await page.locator('input[type="date"]').fill('2026-04-10');
    await page.getByRole('button', { name: /Crear Slots/i }).click();

    // Fase 2 deve mostrar os 2 candidatos
    await expect(page.locator('text=/Agendar Candidatos/i').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Laura Fernández').last()).toBeVisible();
    await expect(page.locator('text=Marcos Oliveira').last()).toBeVisible();
  });

  test('agendamento de candidato dispara POST /book e mostra "Agendado"', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SLOTS_RESPONSE) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: [MOCK_SLOT] }) });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route('**/api/admin/messaging/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
    );

    let capturedBookBody: unknown = null;
    await page.route(`**/api/admin/interview-slots/*/book`, route => {
      capturedBookBody = route.request().postData();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOOK_SUCCESS) });
    });

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });
    await page.locator('input[type="date"]').fill('2026-04-10');
    await page.getByRole('button', { name: /Crear Slots/i }).click();

    await expect(page.locator('text=/Agendar Candidatos/i').first()).toBeVisible({ timeout: 5000 });

    // Clica em "Agendar" para Laura
    await page.getByRole('button', { name: /^Agendar$/i }).first().click();

    // Deve aparecer "Agendado" (status success)
    await expect(page.locator('text=/Agendado/i').first()).toBeVisible({ timeout: 10000 });

    // Verificar que o POST foi disparado
    expect(capturedBookBody).not.toBeNull();
    const body = JSON.parse(capturedBookBody as string);
    expect(body.encuadreId).toBe('worker-sched-001');
  });

  test('quando não há slots disponíveis, exibe "Nenhum slot disponível"', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FULL_SLOTS_RESPONSE) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: [FULL_SLOT] }) });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route('**/api/admin/messaging/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });
    await page.locator('input[type="date"]').fill('2026-04-10');
    await page.getByRole('button', { name: /Crear Slots/i }).click();

    await expect(page.locator('text=/Agendar Candidatos/i').first()).toBeVisible({ timeout: 5000 });

    // Slot cheio — o select deve conter a opção "Nenhum slot disponível" (option element is not visible in DOM sense)
    const slotSelect = page.locator('select').first();
    await expect(slotSelect).toBeVisible({ timeout: 5000 });
    await expect(slotSelect.locator('option[value=""]')).toContainText(/Sin slots disponibles/i);
    // Botão "Agendar" deve estar desabilitado
    await expect(page.getByRole('button', { name: /^Agendar$/i }).first()).toBeDisabled();
  });

  test('botão "Listo" fecha o modal e chama onScheduled', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SLOTS_RESPONSE) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: [MOCK_SLOT] }) });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH) }),
    );
    await page.route('**/api/admin/messaging/templates', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });
    await page.locator('input[type="date"]').fill('2026-04-10');
    await page.getByRole('button', { name: /Crear Slots/i }).click();

    await expect(page.locator('text=/Agendar Candidatos/i').first()).toBeVisible({ timeout: 5000 });

    // Clica "Listo" para fechar sem agendar
    await page.getByRole('button', { name: /Listo/i }).click();

    // Modal deve desaparecer
    await expect(page.locator('text=/Agendar Candidatos/i')).not.toBeVisible({ timeout: 5000 });

    // Seleção deve ter sido limpa (botão "Agendar Entrevista" desaparece)
    await expect(page.getByRole('button', { name: /Agendar Entrevista/i })).not.toBeVisible({ timeout: 3000 });
  });

  test('botão X fecha o modal sem agendar', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Laura Fernández').first()).toBeVisible({ timeout: 15000 });

    const lauraRow = page.locator('tr', { hasText: 'Laura Fernández' }).first();
    await lauraRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Agendar Entrevista/i }).click();

    await expect(page.locator('text=/Configurar Slots/i').first()).toBeVisible({ timeout: 5000 });

    // Fecha com o botão X do modal (scoped ao overlay do modal para evitar ambiguidade com outros botões X da página)
    await page.locator('.fixed.inset-0 button svg.lucide-x').click();

    await expect(page.locator('text=/Configurar Slots/i')).not.toBeVisible({ timeout: 5000 });
  });
});
