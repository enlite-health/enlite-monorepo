/**
 * vacancy-schedule-hydration.integration.e2e.ts @integration — fix bug 25/09
 * (branch `fix/vacancy-schedule-hydration`).
 *
 * `buildScheduleFromVacancy` (`vacancy-form-schema.ts:194`) só aceitava `vacancy.schedule`
 * como ARRAY (a forma persistida em `job_postings.schedule`). O GET de vaga devolve
 * `schedule` NORMALIZADO como OBJETO (`worker-functions/.../scheduleNormalizer.ts`,
 * `normalizeSchedule` — `VacanciesController.ts:282`), então toda edição de vaga com horário
 * abria o formulário com o horário VAZIO, e gravar sem perceber apagava o dado real.
 *
 * Stack: `enlite-api`/`enlite-postgres` COMPARTILHADOS (8080/5432, projeto docker
 * `worker-functions`, já vivos — este teste não sobe nem derruba container nenhum). Vite
 * desta worktree na porta 3000 (5173 ocupada por outra worktree — CORS default do backend
 * só libera `:5173`/`:3000`, `worker-functions/src/shared/http/corsConfig.ts`, sem
 * `CORS_ALLOWED_ORIGINS` setado neste container). Login por UI real + mocks ÚNICOS de
 * Firebase Identity Toolkit / `/api/admin/auth/profile` / `/generate-ai-content` (Gemini
 * custaria) / `/publish-talentum` (canal real proibido) / `/meet-links/lookup` (Google
 * Calendar) — molde `vacancy-draft-wizard-locked.integration.e2e.ts`
 * (`_worktrees/completar-vacante-f4`). GET/PUT de vaga são o backend REAL, sem mock — é
 * exatamente esse round-trip que o bug quebrava.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { execSync } from 'child_process';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
  getVacancyById,
} from '../helpers/db-test-helper';

// ── DB helpers (schedule não é coberto por insertBaseVacancy — mesmo padrão local de
// admin-vacancies-edit-routing.integration.e2e.ts, sem tocar no helper compartilhado) ──────

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${error.stderr?.toString() ?? error.message}`);
  }
}

function setSchedule(vacancyId: string, jsonOrNull: string | null): void {
  const value = jsonOrNull === null ? 'NULL' : `'${jsonOrNull}'::jsonb`;
  runSQL(`UPDATE job_postings SET schedule = ${value} WHERE id = '${vacancyId}'`);
}

function setScheduleDaysHours(vacancyId: string, text: string | null): void {
  const value = text === null ? 'NULL' : `'${text}'`;
  runSQL(`UPDATE job_postings SET schedule_days_hours = ${value} WHERE id = '${vacancyId}'`);
}

// ── Auth mock (molde vacancy-draft-wizard-locked.integration.e2e.ts) ───────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-vacancy-schedule-hydration',
  email: 'admin.schedulehydration@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');

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
  ).toString('base64url') + '.';

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
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
          id_token: FAKE_ID_TOKEN,
          user_id: MOCK_ADMIN_USER.uid,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }] }),
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

  const backendRouteHandler = async (route: Route) => {
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
            firstName: 'Integration',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/generate-ai-content')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { description: 'Se busca Acompañante Terapéutico.', prescreening: { questions: [], faq: [] } },
        }),
      });
      return;
    }

    if (url.includes('/publish-talentum')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { projectId: 'fake-project-id', publicId: '00000000-0000-0000-0000-000000000000', slug: 'schedule-hydration', whatsappUrl: 'https://wa.me/fake' },
        }),
      });
      return;
    }

    if (url.includes('/meet-links/lookup')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { normalized: 'https://meet.google.com/abc-defg-hij', datetime: '2026-06-01T15:00:00-03:00' } }),
      });
      return;
    }

    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  };

  await page.route('**/api/**', backendRouteHandler);
  await page.route('**/v1/me/authz', backendRouteHandler);
}

// `VacancyDaySchedulePicker` (o componente REALMENTE plugado no form, não o
// `SchedulePicker`/`VacancySchedulePicker.tsx` legado) renderiza um card por dia
// (`DAY_KEYS`: Lun/Mar/Mié/Jue/Vie/Sáb/Dom), sem test-id — `.rounded-card` é a classe
// estrutural do componente (medido: `error-context.md` da 1ª tentativa desta suíte, que
// falhou por eu ter assumido o preview do componente ERRADO — a hidratação em si já
// funcionava, com "Lun"/"Mié" mostrando "Horarios (1)" + 08:00/16:00).
function dayCard(page: Page, dayLabel: 'Lun' | 'Mar' | 'Mié' | 'Jue' | 'Vie' | 'Sáb' | 'Dom') {
  return page.locator('.rounded-card').filter({ has: page.getByText(dayLabel, { exact: true }) });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Suite ────────────────────────────────────────────────────────────────────────────────

test.describe('vacancy-schedule-hydration @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let addressId = '';
  const vacancyIds: string[] = [];

  test.beforeAll(() => {
    const seeded = insertTestPatient({
      firstName: 'ScheduleHydration',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
    });
    patientId = seeded.patientId;
    addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();
  });

  test.afterAll(() => {
    cleanupVacancies(vacancyIds);
    cleanupTestPatient(patientId);
  });

  // ── FELIZ ──────────────────────────────────────────────────────────────────────────────
  test('FELIZ — schedule objeto (forma do GET normalizado) hidrata dias/horas e o save preserva', async ({ page }) => {
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber: 9101,
      status: 'PENDING_ACTIVATION',
      isDraft: true, // draft → PUT aceita o payload inteiro do form, não só {schedule,status}
      meetLink1: 'https://meet.google.com/abc-defg-hij',
    });
    vacancyIds.push(vacancyId);
    // Forma PERSISTIDA (array) — o GET do backend devolve isto NORMALIZADO como objeto
    // ({ lunes: [...], miercoles: [...] }), que é a forma que o bug não aceitava.
    setSchedule(
      vacancyId,
      JSON.stringify([
        { dayOfWeek: 1, startTime: '08:00', endTime: '16:00' },
        { dayOfWeek: 3, startTime: '08:00', endTime: '16:00' },
      ]),
    );

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);

    // ANTES do fix, `buildScheduleFromVacancy` devolvia EMPTY_SCHEDULE (objeto não é array) e
    // nenhum card de dia mostrava horário — os dois abaixo ficariam "Horarios" (vazio).
    await expect(dayCard(page, 'Lun').getByText('Horarios (1)')).toBeVisible({ timeout: 15_000 });
    await expect(dayCard(page, 'Lun').getByText('08:00')).toBeVisible();
    await expect(dayCard(page, 'Lun').getByText('16:00')).toBeVisible();
    await expect(dayCard(page, 'Mié').getByText('Horarios (1)')).toBeVisible();
    await expect(dayCard(page, 'Mié').getByText('08:00')).toBeVisible();
    await expect(dayCard(page, 'Mié').getByText('16:00')).toBeVisible();
    // Dia NÃO setado (Mar) continua vazio — a hidratação não vaza pros outros dias.
    await expect(dayCard(page, 'Mar').getByText(/Horarios \(\d+\)/)).toHaveCount(0);

    const putResponse = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/admin/vacancies/${vacancyId}`) &&
        !res.url().includes('meet-links') &&
        res.request().method() === 'PUT',
    );
    await page.getByTestId('create-vacancy-save-btn').click();
    const res = await putResponse;
    expect(res.status(), `PUT falhou: ${res.status()} ${await res.text().catch(() => '')}`).toBe(200);

    // Round-trip: gravar SEM alterar preserva o mesmo conjunto (dia, horário) — ordem pode
    // mudar por causa do agrupamento (`jsonbToSchedule`/`scheduleToJsonb`), valores não.
    const row = getVacancyById(vacancyId);
    expect(row?.schedule, 'schedule ficou NULL após save — o bug voltou').not.toBeNull();
    const persisted = JSON.parse(row!.schedule as string) as { dayOfWeek: number; startTime: string; endTime: string }[];
    const normalize = (arr: typeof persisted) => arr.map((s) => `${s.dayOfWeek}|${s.startTime}|${s.endTime}`).sort();
    expect(normalize(persisted)).toEqual(
      normalize([
        { dayOfWeek: 1, startTime: '08:00', endTime: '16:00' },
        { dayOfWeek: 3, startTime: '08:00', endTime: '16:00' },
      ]),
    );
  });

  // ── ALT 1 ──────────────────────────────────────────────────────────────────────────────
  test('ALT 1 — sem schedule, com schedule_days_hours legado → hidrata do texto', async ({ page }) => {
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber: 9102,
      status: 'PENDING_ACTIVATION',
      isDraft: true,
      meetLink1: 'https://meet.google.com/abc-defg-hij',
    });
    vacancyIds.push(vacancyId);
    setSchedule(vacancyId, null);
    setScheduleDaysHours(vacancyId, 'Lunes, Martes 09:00-17:00');

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);

    await expect(dayCard(page, 'Lun').getByText('Horarios (1)')).toBeVisible({ timeout: 15_000 });
    await expect(dayCard(page, 'Lun').getByText('09:00')).toBeVisible();
    await expect(dayCard(page, 'Lun').getByText('17:00')).toBeVisible();
    await expect(dayCard(page, 'Mar').getByText('Horarios (1)')).toBeVisible();
    await expect(dayCard(page, 'Mar').getByText('09:00')).toBeVisible();
    await expect(dayCard(page, 'Mar').getByText('17:00')).toBeVisible();
  });

  // ── ALT 2 ──────────────────────────────────────────────────────────────────────────────
  test('ALT 2 — sem horário nenhum → formulário vazio, gravar não inventa horário', async ({ page }) => {
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber: 9103,
      status: 'PENDING_ACTIVATION',
      isDraft: true,
      meetLink1: 'https://meet.google.com/abc-defg-hij',
    });
    vacancyIds.push(vacancyId);
    setSchedule(vacancyId, null);
    setScheduleDaysHours(vacancyId, null);

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);

    // Nenhum dia com horário — todos os 7 cards mostram "Horarios" sem contagem. ANTES do
    // fix, `buildScheduleFromVacancy` também devolvia EMPTY_SCHEDULE aqui (`vacancy.schedule`
    // null cai direto no fallback) — este caso já funcionava; a asserção fica como blindagem
    // de regressão (não pode passar a inventar horário quando não há nenhum).
    await expect(page.getByText(/Horarios \(\d+\)/)).toHaveCount(0);

    // `schedule` é campo OBRIGATÓRIO no zod (`vacancy-form-schema.ts:61-63`,
    // `.array(...).min(1)` com `days.min(1)`/`timeFrom.min(1)`/`timeTo.min(1)` por entrada) —
    // achado nesta suíte (1ª tentativa: o clique ficava pendurado 90s porque NENHUM PUT é
    // disparado). "Não inventa horário" aqui é o próprio formulário RECUSANDO salvar sem
    // schedule, não um POST/PUT silencioso com valor vazio — a prova mais forte possível: o
    // dado nunca sai do browser.
    await page.getByTestId('create-vacancy-save-btn').click();
    await expect(page.getByTestId('vacancy-form-validation-error')).toBeVisible({ timeout: 10_000 });

    const row = getVacancyById(vacancyId);
    expect(row?.schedule ?? null, 'gravar inventou um schedule que não existia').toBeNull();
  });
});
