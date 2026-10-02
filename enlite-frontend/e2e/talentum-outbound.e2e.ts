/**
 * talentum-outbound.e2e.ts — Playwright E2E
 *
 * Testes visuais dos componentes Talentum no painel admin:
 *   1. VacancyFormModal — criar/editar vaga
 *   2. VacancyPrescreeningConfig — configuração de perguntas + FAQ
 *   3. VacancyTalentumCard — switch publicar/despublicar + link WhatsApp
 *
 * Todas as chamadas à API backend são mockadas via page.route().
 * Comunicação com Talentum/Groq nunca ocorre.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const MOCK_VACANCY_ID = 'aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa';

// ── Mock Data ────────────────────────────────────────────────────────

const MOCK_VACANCY_UNPUBLISHED = {
  id: MOCK_VACANCY_ID,
  case_number: 22001,
  title: 'Caso 22001 — TEA Adulto',
  status: 'BUSQUEDA',
  country: 'Argentina',
  providers_needed: 1,
  worker_profile_sought: 'AT con experiencia en adultos mayores',
  schedule_days_hours: 'Lunes a Viernes 09-17hs',
  patient_id: null,
  patient_first_name: 'Juan',
  patient_last_name: 'Pérez',
  patient_zone: 'Palermo',
  talentum_project_id: null,
  talentum_whatsapp_url: null,
  talentum_slug: null,
  talentum_published_at: null,
  talentum_description: null,
  encuadres: [],
  publications: [],
};

const MOCK_VACANCY_PUBLISHED = {
  ...MOCK_VACANCY_UNPUBLISHED,
  talentum_project_id: 'proj-mock-123',
  talentum_whatsapp_url: 'https://wa.me/5491127227852?text=Hola%20soy%20candidato',
  talentum_slug: 'u8m1outj',
  talentum_published_at: '2026-04-01T19:49:00Z',
  talentum_description: 'Descripción de la Propuesta:\nSe busca profesional AT para acompañamiento...',
};

const MOCK_VACANCIES_LIST = {
  success: true,
  data: [
    {
      id: MOCK_VACANCY_ID,
      case_number: 22001,
      title: 'Caso 22001 — TEA Adulto',
      status: 'BUSQUEDA',
      providers_needed: 1,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_PRESCREENING_EMPTY = {
  success: true,
  data: { questions: [], faq: [] },
};

const MOCK_PRESCREENING_WITH_QUESTIONS = {
  success: true,
  data: {
    questions: [
      {
        id: 'q-1',
        question: '¿Cuál es tu experiencia con pacientes TEA?',
        responseType: ['text', 'audio'],
        desiredResponse: 'Mínimo 6 meses de experiencia',
        weight: 8,
        required: true,
        analyzed: true,
        earlyStoppage: false,
        questionOrder: 1,
      },
      {
        id: 'q-2',
        question: '¿Tenés disponibilidad horaria completa?',
        responseType: ['text'],
        desiredResponse: 'Sí, lunes a viernes',
        weight: 6,
        required: false,
        analyzed: true,
        earlyStoppage: false,
        questionOrder: 2,
      },
    ],
    faq: [
      {
        id: 'f-1',
        question: '¿Cuál es el salario?',
        answer: 'A convenir según experiencia',
        faqOrder: 1,
      },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email = `e2e.talentum.out.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as any;

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at) VALUES ('${uid}', '${email}', 'Admin Talentum E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at) VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* mock below covers this */ }

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid, email, role: 'superadmin',
          firstName: 'Admin', lastName: 'Talentum',
          isActive: true, mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

function mockVacancyDetail(page: Page, vacancy: typeof MOCK_VACANCY_UNPUBLISHED) {
  return page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: vacancy }),
    }),
  );
}

function mockVacancyList(page: Page) {
  return page.route('**/api/admin/vacancies?**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_VACANCIES_LIST),
    }),
  );
}

function mockStats(page: Page) {
  return page.route('**/api/admin/vacancies/stats', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Talentum Outbound — Frontend', () => {
  test.setTimeout(60000);

  // ═══════════════════════════════════════════════════════════════════
  // 1. VacancyFormModal
  // ═══════════════════════════════════════════════════════════════════

  test.describe('VacancyFormModal — Crear Vacante', () => {
    test('modal abre al hacer clic en "Nueva Vacante" y muestra todos los campos', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyList(page);
      await mockStats(page);

      await page.goto('/admin/vacancies');
      await expect(page.locator('text=22001').first()).toBeVisible({ timeout: 15000 });

      // Buscar y hacer clic en botón "Nueva Vacante" o similar
      const newBtn = page.getByRole('button', { name: /Nueva/i });
      await expect(newBtn).toBeVisible({ timeout: 10000 });
      await newBtn.click();

      // Modal visible con título en español
      await expect(page.locator('text=/Crear Vacante|Nueva Vacante/i').first()).toBeVisible({ timeout: 5000 });

      // Todos los campos del formulario están visibles
      await expect(page.locator('text=/Número de Caso/i').first()).toBeVisible();
      await expect(page.locator('text=/Título/i').first()).toBeVisible();
      await expect(page.locator('text=/Paciente/i').first()).toBeVisible();
      await expect(page.locator('text=/Perfil buscado/i').first()).toBeVisible();
      await expect(page.locator('text=/Horarios/i').first()).toBeVisible();
      await expect(page.locator('text=/Cantidad de prestadores/i').first()).toBeVisible();
      await expect(page.locator('text=/Observaciones/i').first()).toBeVisible();
      await expect(page.locator('text=/Estado/i').first()).toBeVisible();

      // Botones del modal
      await expect(page.getByRole('button', { name: /Cancelar/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Crear/i })).toBeVisible();
    });

    test('muestra errores de validación en español cuando campos obligatorios están vacíos', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyList(page);
      await mockStats(page);

      await page.goto('/admin/vacancies');
      await expect(page.locator('text=22001').first()).toBeVisible({ timeout: 15000 });

      const newBtn = page.getByRole('button', { name: /Nueva/i });
      await newBtn.click();
      await expect(page.locator('text=/Crear Vacante|Nueva Vacante/i').first()).toBeVisible({ timeout: 5000 });

      // Intentar enviar sin llenar campos
      await page.getByRole('button', { name: /^Crear$/i }).click();

      // Errores de validación en español
      await expect(page.locator('text=/obligatorio/i').first()).toBeVisible({ timeout: 5000 });
    });

    test('modal se cierra al hacer clic en Cancelar', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyList(page);
      await mockStats(page);

      await page.goto('/admin/vacancies');
      await expect(page.locator('text=22001').first()).toBeVisible({ timeout: 15000 });

      const newBtn = page.getByRole('button', { name: /Nueva/i });
      await newBtn.click();
      await expect(page.locator('text=/Crear Vacante|Nueva Vacante/i').first()).toBeVisible({ timeout: 5000 });

      await page.getByRole('button', { name: /Cancelar/i }).click();

      // Modal ya no visible
      await expect(page.locator('text=/Crear Vacante|Nueva Vacante/i').first()).not.toBeVisible({ timeout: 3000 });
    });

    test('select de Estado muestra opciones en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyList(page);
      await mockStats(page);

      await page.goto('/admin/vacancies');
      await expect(page.locator('text=22001').first()).toBeVisible({ timeout: 15000 });

      const newBtn = page.getByRole('button', { name: /Nueva/i });
      await newBtn.click();
      await expect(page.locator('text=/Crear Vacante|Nueva Vacante/i').first()).toBeVisible({ timeout: 5000 });

      // Verificar que el select de status tiene las opciones
      const statusSelect = page.locator('select');
      const options = await statusSelect.locator('option').allTextContents();
      expect(options.length).toBeGreaterThanOrEqual(4);
      // Al menos debe tener BUSQUEDA como opción (puede ser traducida)
      expect(options.some(o => /BUSQUEDA|Búsqueda/i.test(o))).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. VacancyPrescreeningConfig
  // ═══════════════════════════════════════════════════════════════════

  test.describe('VacancyPrescreeningConfig', () => {
    test('muestra estado vacío con mensaje en español y botón "Agregar Pregunta"', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

      // Título de la sección en español
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Mensaje vacío en español
      await expect(page.locator('text=/no hay preguntas/i').first()).toBeVisible();

      // Botón agregar pregunta
      await expect(page.getByRole('button', { name: /Agregar Pregunta/i })).toBeVisible();

      // Sección FAQ con título en español
      await expect(page.locator('text=Preguntas Frecuentes').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Agregar FAQ/i })).toBeVisible();
    });

    test('agregar pregunta muestra card con todos los campos en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Click "Agregar Pregunta"
      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();

      // Card de pregunta 1 visible
      await expect(page.locator('text=Pregunta 1').first()).toBeVisible({ timeout: 5000 });

      // Labels en español
      await expect(page.locator('text=/Tipo de respuesta/i').first()).toBeVisible();
      await expect(page.locator('text=Texto').first()).toBeVisible();
      await expect(page.locator('text=Audio').first()).toBeVisible();
      await expect(page.locator('text=/Respuesta esperada/i').first()).toBeVisible();
      await expect(page.locator('text=/Peso.*1.*10/i').first()).toBeVisible();

      // Configuración avanzada
      await expect(page.locator('text=/Configuración avanzada/i').first()).toBeVisible();
    });

    test('expandir configuración avanzada muestra checkboxes en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();
      await expect(page.locator('text=Pregunta 1').first()).toBeVisible({ timeout: 5000 });

      // Expandir configuración avanzada
      await page.locator('text=/Configuración avanzada/i').first().click();

      // Checkboxes en español
      await expect(page.locator('text=Requerida').first()).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=/Analizada por IA/i').first()).toBeVisible();
      await expect(page.locator('text=/Early stop/i').first()).toBeVisible();
    });

    test('muestra preguntas existentes cargadas desde la API', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Pregunta 1 y Pregunta 2 visibles con contenido
      await expect(page.locator('text=Pregunta 1').first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator('text=Pregunta 2').first()).toBeVisible();

      // Texto de la pregunta 1 en el textarea
      await expect(page.locator('textarea').first()).toHaveValue('¿Cuál es tu experiencia con pacientes TEA?');

      // FAQ cargada
      await expect(page.locator('text=FAQ 1').first()).toBeVisible();
    });

    test('guardar configuración muestra feedback de éxito en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      // GET returns empty, POST returns saved
      let getCallCount = 0;
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route => {
        if (route.request().method() === 'GET') {
          getCallCount++;
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) });
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) });
        }
      });

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Agregar pregunta y llenar datos
      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();
      const textareas = page.locator('textarea');
      await textareas.nth(0).fill('¿Experiencia con TEA?');
      await textareas.nth(1).fill('Mínimo 6 meses');

      // Guardar
      await page.getByRole('button', { name: /Guardar Configuración/i }).click();

      // Feedback de éxito en español
      await expect(page.locator('text=/guardada con éxito/i').first()).toBeVisible({ timeout: 5000 });
    });

    test('validación muestra errores en español cuando los campos obligatorios están vacíos', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Agregar pregunta vacía
      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();
      await expect(page.locator('text=Pregunta 1').first()).toBeVisible({ timeout: 5000 });

      // Intentar guardar sin llenar
      await page.getByRole('button', { name: /Guardar Configuración/i }).click();

      // Errores de validación en español
      await expect(page.locator('text=/pregunta es obligatoria/i').first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator('text=/respuesta esperada es obligatoria/i').first()).toBeVisible();
    });

    test('eliminar pregunta la remueve de la lista', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Agregar 2 preguntas
      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();
      await page.getByRole('button', { name: /Agregar Pregunta/i }).click();
      await expect(page.locator('text=Pregunta 2').first()).toBeVisible({ timeout: 3000 });

      // Eliminar primera pregunta (ícono de basura)
      const deleteButtons = page.locator('button').filter({ has: page.locator('svg.lucide-trash-2') });
      await deleteButtons.first().click();

      // Solo queda Pregunta 1 (renumerada)
      await expect(page.locator('text=Pregunta 1').first()).toBeVisible();
      await expect(page.locator('text=Pregunta 2')).not.toBeVisible({ timeout: 2000 });
    });

    test('aviso en español cuando la vaga ya está publicada', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_PUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Warning en español
      await expect(page.locator('text=/Ya publicada.*cambios no se reflejan/i').first()).toBeVisible({ timeout: 5000 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. VacancyTalentumCard
  // ═══════════════════════════════════════════════════════════════════

  test.describe('VacancyTalentumCard — Estado no publicado', () => {
    test('muestra card con título, switch y descripción vacía en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

      // Card visible con título en español
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Descripción vacía en español
      await expect(page.locator('text=/Sin descripción generada/i').first()).toBeVisible();

      // Botón regenerar en español
      await expect(page.getByRole('button', { name: /Regenerar descripción/i })).toBeVisible();

      // Switch label en español
      await expect(page.locator('text=Publicar en Talentum').first()).toBeVisible();

      // Switch está OFF (role=switch, aria-checked=false)
      const toggle = page.locator('[role="switch"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    test('switch deshabilitado sin preguntas configuradas, muestra aviso en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_EMPTY) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Aviso en español: "Configurá al menos 1 pregunta antes de publicar"
      await expect(page.locator('text=/al menos 1 pregunta/i').first()).toBeVisible({ timeout: 10000 });

      // Switch disabled
      const toggle = page.locator('[role="switch"]');
      await expect(toggle).toBeDisabled();
    });

    test('botón "Regenerar descripción" hace llamada API y muestra resultado', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      // Mock generate description
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/generate-talentum-description`, route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { description: 'Descripción de la Propuesta:\nSe busca un AT profesional para...\n\nPerfil Profesional Sugerido:\nMujer, con experiencia...\n\nEl Marco de Acompañamiento:\nEnLite Health Solutions...' },
          }),
        }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Click regenerar
      await page.getByRole('button', { name: /Regenerar descripción/i }).click();

      // Descripción generada visible
      await expect(page.locator('text=/Descripción de la Propuesta/i').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=/EnLite Health Solutions/i').first()).toBeVisible();
    });

    test('muestra descripción existente cuando talentum_description tiene valor', async ({ page }) => {
      await seedAdminAndLogin(page);

      const vacancyWithDesc = {
        ...MOCK_VACANCY_UNPUBLISHED,
        talentum_description: 'Descripción de la Propuesta:\nContenido de prueba preexistente...',
      };

      await mockVacancyDetail(page, vacancyWithDesc);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Descripción existente visible
      await expect(page.locator('text=/Contenido de prueba preexistente/i').first()).toBeVisible({ timeout: 5000 });

      // "Sin descripción" NO visible
      await expect(page.locator('text=/Sin descripción generada/i')).not.toBeVisible();
    });
  });

  test.describe('VacancyTalentumCard — Estado publicado', () => {
    test('muestra badge "Activo", link WhatsApp, slug, fecha y preguntas', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_PUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Badge "Activo"
      await expect(page.locator('text=Activo').first()).toBeVisible({ timeout: 5000 });

      // Link WhatsApp visible
      await expect(page.locator('text=Link de preselección web').first()).toBeVisible();
      await expect(page.locator('text=/wa.me/i').first()).toBeVisible();

      // Slug visible
      await expect(page.locator('text=Slug').first()).toBeVisible();
      await expect(page.locator('text=/u8m1outj/i').first()).toBeVisible();

      // Fecha publicado
      await expect(page.locator('text=Publicado').first()).toBeVisible();

      // Cantidad de preguntas
      await expect(page.locator('text=Preguntas').first()).toBeVisible();

      // Switch ON
      const toggle = page.locator('[role="switch"]');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    test('botón copiar link funciona', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_PUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      // Grant clipboard permission
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Click botón copiar (svg Copy icon)
      const copyButton = page.locator('button[title="Copiar link"]');
      await expect(copyButton).toBeVisible({ timeout: 5000 });
      await copyButton.click();

      // "¡Copiado!" feedback
      await expect(page.locator('text=¡Copiado!').first()).toBeVisible({ timeout: 3000 });
    });

    test('switch OFF pide confirmación en español para despublicar', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_PUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('text=Activo').first()).toBeVisible({ timeout: 5000 });

      // Interceptar confirm dialog
      page.on('dialog', async dialog => {
        // Verificar que el mensaje está en español
        expect(dialog.message()).toContain('eliminará');
        await dialog.dismiss(); // Cancelar
      });

      // Click switch (toggle OFF)
      const toggle = page.locator('[role="switch"]');
      await toggle.click();
    });

    test('despublicar con éxito muestra feedback en español', async ({ page }) => {
      await seedAdminAndLogin(page);

      let callCount = 0;
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route => {
        callCount++;
        const data = callCount <= 1 ? MOCK_VACANCY_PUBLISHED : MOCK_VACANCY_UNPUBLISHED;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      });

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      // Mock unpublish
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/publish-talentum`, route => {
        if (route.request().method() === 'DELETE') {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        }
      });

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Activo').first()).toBeVisible({ timeout: 15000 });

      // Aceptar confirm dialog
      page.on('dialog', dialog => dialog.accept());

      // Click switch
      await page.locator('[role="switch"]').click();

      // Feedback éxito en español
      await expect(page.locator('text=/despublicada de Talentum/i').first()).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('VacancyTalentumCard — Publicar', () => {
    test('switch ON pide confirmación en español y publica', async ({ page }) => {
      await seedAdminAndLogin(page);

      let callCount = 0;
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route => {
        callCount++;
        const data = callCount <= 1 ? MOCK_VACANCY_UNPUBLISHED : MOCK_VACANCY_PUBLISHED;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      });

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      // Mock publish
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/publish-talentum`, route => {
        if (route.request().method() === 'POST') {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { projectId: 'proj-new', publicId: 'pub-new', whatsappUrl: 'https://wa.me/123' },
            }),
          });
        }
      });

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      // Aceptar confirm dialog
      page.on('dialog', async dialog => {
        expect(dialog.message()).toContain('creará');
        await dialog.accept();
      });

      // Wait for switch to be enabled (questions loaded)
      const toggle = page.locator('[role="switch"]');
      await expect(toggle).toBeEnabled({ timeout: 10000 });

      // Click switch
      await toggle.click();

      // Feedback éxito en español
      await expect(page.locator('text=/publicada en Talentum con éxito/i').first()).toBeVisible({ timeout: 10000 });
    });

    test('error al publicar muestra feedback en español', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      // Mock publish failure
      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/publish-talentum`, route =>
        route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Talentum API error' }),
        }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Talentum Pre-Screening').first()).toBeVisible({ timeout: 15000 });

      page.on('dialog', dialog => dialog.accept());

      const toggle = page.locator('[role="switch"]');
      await expect(toggle).toBeEnabled({ timeout: 10000 });
      await toggle.click();

      // Feedback error (el texto del error o el mensaje genérico)
      await expect(
        page.locator('text=/error|Error/i').first(),
      ).toBeVisible({ timeout: 10000 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. i18n — Verificación de que NO hay textos en inglés/portugués
  // ═══════════════════════════════════════════════════════════════════

  test.describe('i18n — Textos en español argentino', () => {
    test('VacancyDetailPage no muestra textos hardcoded en inglés', async ({ page }) => {
      await seedAdminAndLogin(page);
      await mockVacancyDetail(page, MOCK_VACANCY_UNPUBLISHED);

      await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRESCREENING_WITH_QUESTIONS) }),
      );

      await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
      await expect(page.locator('text=Configuración Pre-Screening Talentum').first()).toBeVisible({ timeout: 15000 });

      // Verificar que textos clave están en español
      const bodyText = await page.locator('body').textContent();

      // No debe haber textos en inglés de los componentes Talentum
      expect(bodyText).not.toContain('Save Configuration');
      expect(bodyText).not.toContain('Add Question');
      expect(bodyText).not.toContain('Add FAQ');
      expect(bodyText).not.toContain('Publish to Talentum');
      expect(bodyText).not.toContain('No questions configured');
      expect(bodyText).not.toContain('Copy link');

      // Debe tener textos en español
      expect(bodyText).toContain('Guardar Configuración');
      expect(bodyText).toContain('Agregar Pregunta');
      expect(bodyText).toContain('Publicar en Talentum');
    });
  });
});
