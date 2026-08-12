/**
 * vacancy-detail-localized-edit.e2e.ts
 *
 * Playwright E2E com VALIDAÇÃO VISUAL — Tela de Detalhe da Vaga: edição localizada.
 *
 * Regra de negócio: vagas que saíram do rascunho (status ≠ PENDING_ACTIVATION)
 * só podem editar HORÁRIOS e ESTADO.
 *
 * Cada teste tem screenshot assertion (`toHaveScreenshot`) que valida o estado
 * visual final, garantindo que mudanças futuras de CSS, layout ou comportamento
 * sejam detectadas em CI.
 *
 * Estados cobertos visualmente:
 *  - Página em estado inicial (status badge editável visível, ícone de lápis,
 *    ausência do botão genérico "Editar Vaga")
 *  - Dropdown de status aberto
 *  - Loader spinning no badge enquanto PUT está em curso
 *  - Badge com cor nova depois de salvar (SUSPENDED → bg-gray-800)
 *  - Modal de horários aberto com schedule carregado
 *  - Modal exibindo mensagem de erro quando schedule é inválido
 *  - Grid de horários atualizada na página depois de salvar
 *
 * Login: Firebase Auth de produção via env vars E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
 * Backend mockado via page.route — nenhuma chamada real ao backend.
 */

import { test, expect, Page } from '@playwright/test';

const E2E_EMAIL = process.env.E2E_ADMIN_EMAIL;
const E2E_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const MOCK_VACANCY_ID = 'bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb';

interface ScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

type NormalizedSchedule = Record<string, Array<{ start: string; end: string }>>;

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Simula o normalize que o backend faz no GET — array → record keyed by day. */
function normalizeSchedule(raw: ScheduleSlot[] | NormalizedSchedule | null): NormalizedSchedule | null {
  if (!raw) return null;
  if (!Array.isArray(raw)) return raw;
  const result: NormalizedSchedule = {};
  for (const slot of raw) {
    const dayName = DAY_NAMES[slot.dayOfWeek];
    if (!dayName) continue;
    if (!result[dayName]) result[dayName] = [];
    result[dayName].push({ start: slot.startTime, end: slot.endTime });
  }
  return Object.keys(result).length > 0 ? result : null;
}

interface MockVacancy {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  country: string;
  providers_needed: number;
  worker_profile_sought: string;
  schedule: NormalizedSchedule | null;
  schedule_days_hours: string | null;
  patient_id: string;
  patient_first_name: string;
  patient_last_name: string;
  patient_zone: string;
  patient_city: string;
  patient_neighborhood: string;
  insurance_verified: boolean;
  required_professions: string[];
  required_sex: string;
  pathology_types: string;
  encuadres: unknown[];
  publications: unknown[];
  meet_link_1: null;
  meet_datetime_1: null;
  meet_link_2: null;
  meet_datetime_2: null;
  meet_link_3: null;
  meet_datetime_3: null;
}

const baseVacancy: MockVacancy = {
  id: MOCK_VACANCY_ID,
  case_number: 22002,
  vacancy_number: 1,
  title: 'Caso 22002 — Vacante Operacional',
  status: 'SEARCHING',
  country: 'Argentina',
  providers_needed: 1,
  worker_profile_sought: 'AT',
  // Formato pós-normalize (igual o backend faz no GET) — necessário pra ScheduleGrid
  schedule: { lunes: [{ start: '09:00', end: '13:00' }] },
  // String legacy mantida pra o modal abrir pré-populado (buildScheduleFromVacancy
  // só lê Array; com Record cai no fallback de schedule_days_hours)
  schedule_days_hours: 'Lunes 09:00-13:00',
  patient_id: 'patient-22002',
  patient_first_name: 'Paciente',
  patient_last_name: 'Operacional',
  patient_zone: 'Palermo',
  patient_city: 'CABA',
  patient_neighborhood: 'Palermo',
  insurance_verified: true,
  required_professions: ['AT'],
  required_sex: 'F',
  pathology_types: 'TEA',
  encuadres: [],
  publications: [],
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function loginAndMockApi(page: Page): Promise<void> {
  if (!E2E_EMAIL || !E2E_PASSWORD) {
    test.skip(true, 'E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD não configurados');
  }
  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'mock-admin-id',
          email: E2E_EMAIL,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'Test',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(E2E_EMAIL!);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD!);
  await page.locator('button[type="submit"]').first().click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 25000 });
}

interface ApiSpy {
  putBodies: Array<Record<string, unknown>>;
}

/**
 * Instala mock GET + PUT em /vacancies/:id. PUT pode ter delay artificial pra
 * permitir capturar o estado "saving" visual; também pode merging os campos
 * recebidos na próxima resposta GET pra simular refetch.
 */
async function mockVacancyApi(
  page: Page,
  options: { putDelayMs?: number } = {},
): Promise<ApiSpy> {
  const spy: ApiSpy = { putBodies: [] };
  let currentVacancy: MockVacancy = { ...baseVacancy };

  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, async route => {
    const req = route.request();
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
      spy.putBodies.push(body);
      if (options.putDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.putDelayMs));
      }
      // Aplica o body do PUT no estado mock e normaliza schedule como o backend faz
      const merged: MockVacancy = { ...currentVacancy };
      for (const [key, value] of Object.entries(body)) {
        if (key === 'schedule' && Array.isArray(value)) {
          merged.schedule = normalizeSchedule(value as ScheduleSlot[]);
        } else {
          (merged as unknown as Record<string, unknown>)[key] = value;
        }
      }
      currentVacancy = merged;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: currentVacancy }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: currentVacancy }),
    });
  });

  return spy;
}

// Locators reutilizados
const statusEditorTrigger = (page: Page) => page.getByTestId('vacancy-status-editor-trigger');
const statusDropdown = (page: Page) => page.getByTestId('vacancy-status-editor-dropdown');
const editScheduleTrigger = (page: Page) => page.getByTestId('vacancy-edit-schedule-trigger');
const scheduleModal = (page: Page) => page.getByTestId('vacancy-schedule-modal');

// ── Testes ─────────────────────────────────────────────────────────────────

test.describe('VacancyDetailPage — edição localizada (validação visual)', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('estado inicial: badge editável + ícone de lápis visíveis, sem botão "Editar Vaga"', async ({ page }) => {
    await mockVacancyApi(page);
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    // Garantias funcionais
    await expect(statusEditorTrigger(page)).toBeVisible();
    await expect(editScheduleTrigger(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Editar$/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /Editar Vacante|Editar Vaga/i })).not.toBeVisible();

    // Garantia visual: snapshot da parte superior da página (header + 1ª linha de cards)
    await expect(page).toHaveScreenshot('01-pagina-estado-inicial.png', {
      clip: { x: 0, y: 0, width: 1440, height: 700 },
      maxDiffPixelRatio: 0.02,
    });
  });

  test('badge close-up: chevron presente e dropdown abre com 6 opções editáveis', async ({ page }) => {
    await mockVacancyApi(page);
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    const trigger = statusEditorTrigger(page);
    await expect(trigger).toBeVisible();

    // Close-up do badge fechado (mostra que tem chevron-down ao lado, indicando editável)
    await expect(trigger).toHaveScreenshot('02-badge-status-fechado-closeup.png', {
      maxDiffPixelRatio: 0.02,
    });

    await trigger.click();
    await expect(statusDropdown(page)).toBeVisible();

    // Confirma as 6 opções editáveis (PENDING_ACTIVATION fica de fora — não-editável aqui)
    await expect(page.getByTestId('vacancy-status-option-SEARCHING')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-SEARCHING_REPLACEMENT')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-RAPID_RESPONSE')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-ACTIVE')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-SUSPENDED')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-CLOSED')).toBeVisible();
    await expect(page.getByTestId('vacancy-status-option-PENDING_ACTIVATION')).not.toBeVisible();

    // Snapshot do dropdown aberto na sua área completa
    await expect(statusDropdown(page)).toHaveScreenshot('03-status-dropdown-aberto.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('salvar status mostra loader e depois badge muda visualmente', async ({ page }) => {
    // Delay artificial de 600ms no PUT pra dar tempo de capturar o estado "saving"
    const spy = await mockVacancyApi(page, { putDelayMs: 600 });
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    const trigger = statusEditorTrigger(page);
    await trigger.click();
    await page.getByTestId('vacancy-status-option-SUSPENDED').click();

    // Estado "saving" — Loader2 spinning no lugar do chevron, botão desabilitado
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveScreenshot('04-status-saving-loader.png', {
      maxDiffPixelRatio: 0.05, // loader pode ter pequena variação de rotação
      animations: 'disabled',
    });

    // Espera o PUT completar
    await expect.poll(() => spy.putBodies.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(spy.putBodies[0]).toEqual({ status: 'SUSPENDED' });

    // Estado final — badge agora reflete SUSPENDED (cor diferente: bg-gray-800)
    await expect(trigger).not.toBeDisabled({ timeout: 5000 });
    await expect(trigger).toHaveScreenshot('05-status-apos-salvar-suspendido.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('ícone de lápis abre modal de horários com schedule pré-carregado', async ({ page }) => {
    await mockVacancyApi(page);
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    // Close-up do ícone de lápis ao lado de "Días y horarios"
    const pencil = editScheduleTrigger(page);
    await expect(pencil).toBeVisible();
    await expect(pencil).toHaveScreenshot('06-icone-lapis-closeup.png', {
      maxDiffPixelRatio: 0.02,
    });

    await pencil.click();
    await expect(scheduleModal(page)).toBeVisible();
    await expect(page.getByTestId('vacancy-schedule-save')).toBeVisible();

    // O modal abre com o schedule do mock (Lun 09:00-13:00) já preenchido
    await expect(scheduleModal(page).locator('text=09:00').first()).toBeVisible();
    await expect(scheduleModal(page).locator('text=13:00').first()).toBeVisible();

    // Snapshot do modal completo
    await expect(scheduleModal(page)).toHaveScreenshot('07-modal-schedule-aberto.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('modal exibe erro visual quando user tenta salvar schedule sem dias selecionados', async ({ page }) => {
    // Vaga sem schedule pré-existente — modal abre vazio, save fica inválido
    const emptyVacancy = { ...baseVacancy, schedule: null, schedule_days_hours: null };
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: emptyVacancy }),
        });
        return;
      }
      await route.continue();
    });
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    await editScheduleTrigger(page).click();
    await expect(scheduleModal(page)).toBeVisible();

    // Snapshot do modal sem schedule (estado vazio inicial)
    await expect(scheduleModal(page)).toHaveScreenshot('08-modal-schedule-vazio.png', {
      maxDiffPixelRatio: 0.02,
    });

    // Clica em salvar sem ter horário válido → erro visual aparece dentro do modal
    await page.getByTestId('vacancy-schedule-save').click();
    await expect(scheduleModal(page).locator('text=/horario válido|Adicione|Agregá/i')).toBeVisible();

    // Snapshot do modal mostrando a mensagem de erro
    await expect(scheduleModal(page)).toHaveScreenshot('09-modal-schedule-erro-vazio.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('salvar schedule envia PUT só com { schedule } e a grid da página atualiza', async ({ page }) => {
    const spy = await mockVacancyApi(page);
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    await editScheduleTrigger(page).click();
    await expect(scheduleModal(page)).toBeVisible();

    // Salva sem alterar (schedule do mock já é válido: Lun 09-13)
    await page.getByTestId('vacancy-schedule-save').click();

    await expect.poll(() => spy.putBodies.length, { timeout: 5000 }).toBeGreaterThan(0);
    const body = spy.putBodies[0];
    expect(body).toHaveProperty('schedule');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('patient_id');

    // Modal fecha e a grid da página renderiza o schedule
    await expect(scheduleModal(page)).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=09:00h - 13:00h').first()).toBeVisible();

    // Snapshot final da página com schedule visível e nada mais editável além de status+horário
    await expect(page).toHaveScreenshot('10-pagina-apos-salvar-schedule.png', {
      clip: { x: 0, y: 0, width: 1440, height: 700 },
      maxDiffPixelRatio: 0.02,
    });
  });

  test('header do ProfessionCard NÃO tem botão "Editar Vaga" genérico (visual completo do card)', async ({ page }) => {
    await mockVacancyApi(page);
    await loginAndMockApi(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=22002').first()).toBeVisible({ timeout: 15000 });

    // Aguarda card de profissão renderizar
    const professionCard = page.locator('text=Acompañantes Terapéuticos').locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');
    await expect(professionCard).toBeVisible();

    // Garantia visual: snapshot do card de profissão inteiro
    await expect(professionCard).toHaveScreenshot('11-profession-card-sem-botao-editar.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
