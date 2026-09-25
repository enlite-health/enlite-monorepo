/**
 * admin-vacancies-edit-routing.integration.e2e.ts @integration
 *
 * Full-stack E2E — valida o roteamento do CLIQUE NA LINHA na listagem de vagas
 * (AdminVacanciesPage) em função de `is_draft` da vaga.
 *
 * Reescrito na Fase 3 (`completar-vacante-em-rascunho`, F25/D425/D426, 25/09): o lápis
 * (`edit-vacancy-${id}`) e o `VacancyModal` antigo SAÍRAM da lista — quem decide o destino
 * agora é o clique na linha inteira:
 *   - Linha non-draft → clique navega direto pra `/admin/vacancies/{id}` (o detalhe), igual
 *     sempre foi.
 *   - Linha draft → clique abre o modal `DraftVacancyChoiceDialog` ("¿Qué querés hacer con
 *     este borrador?") para quem tem `talentum:update` + `vacancy:update`. Este stack roda
 *     com o engine ABAC OFF — `useActionGate` devolve `allowed: true` sempre que
 *     `enforcement !== 'on'` (`useCellAccess.ts:70`), então o modal abre pra qualquer admin
 *     autenticado aqui. A bifurcação por permissão REAL (ator SEM as células) está provada à
 *     parte, com o engine ligado, em `draft-vacancy-choice-dialog.integration.e2e.ts`.
 *
 * Roda contra um stack ISOLADO próprio (projeto docker `cv-fase3-standard`, Postgres `5472`,
 * API `8122`, Vite `5193`) — achado 25/09 (gate parcial): o stack padrão `enlite-api`/
 * `enlite-postgres` (8080/5432) e a porta 5173 já estavam ocupados pelo Vite de OUTRA worktree
 * (`_worktrees/completar-vacante`), e o CORS default do backend só libera `:5173`/`:3000`
 * (`corsConfig.ts`) — um Vite desta worktree noutra porta contra esses containers falha em
 * silêncio (nenhum dado carrega, tela presa em skeleton).
 *
 * COMO SUBIR. O bloco de ENGINE fica de fora de propósito aqui — este é o stack OFF, não usa
 * `docker-compose.group-simulation.yml`. `worker-functions/docker-compose.fase3-standard.local.yml`
 * — não existe no git (gitignorado, `docker-compose.*.local.yml`); recriar com este conteúdo:
 *   services:
 *     postgres:
 *       container_name: cv-fase3-standard-postgres
 *       ports: !override
 *         - "5472:5432"
 *     api:
 *       image: worker-functions-api
 *       container_name: cv-fase3-standard-api
 *       ports: !override
 *         - "8122:8080"
 *       environment:
 *         CORS_ALLOWED_ORIGINS: "http://localhost:5193"
 *
 *   cd worker-functions
 *   docker compose -p cv-fase3-standard -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.fase3-standard.local.yml up -d postgres api
 *   cd ../enlite-frontend && VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8122 <demais VITE_FIREBASE_*> \
 *     npx vite --port 5193 --strictPort
 *   E2E_PG_CONTAINER=cv-fase3-standard-postgres PW_BASE_URL=http://localhost:5193 \
 *     npx playwright test --project=integration --grep "edit routing por is_draft"
 *
 * Regra de fundo, ainda válida (autoritativa no backend `vacancyCrudHelpers.ts`):
 *   - Vagas com `is_draft = true`  → operador ainda pode editar todos os campos.
 *   - Vagas com `is_draft = false` → backend bloqueia com 403 qualquer campo
 *     fora de { schedule, status }. O fluxo correto é editar no detalhe via
 *     VacancyScheduleEditModal + VacancyStatusEditor.
 *
 * Esses cenários blindam:
 *   1. Clique na linha non-draft (status SEARCHING_REPLACEMENT) → NAVEGA pra
 *      /admin/vacancies/{id}, nenhum dialog no DOM.
 *   2. Clique na linha draft (status PENDING_ACTIVATION) → abre o
 *      `DraftVacancyChoiceDialog`.
 *   3. No detalhe, abrir VacancyScheduleEditModal + salvar uma alteração de
 *      schedule numa vaga non-draft NÃO retorna 403 — o endpoint aceita o
 *      payload restrito { schedule }.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
} from '../helpers/db-test-helper';
import { execSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-edit-routing',
  email: 'admin.edit-routing@e2e.test',
  role: 'admin',
  // Sem isto, `/v1/me/authz` (agora interceptado — ver `installInterceptors`) devolve
  // 401/403 mudo e o login nunca sai de `/admin/login` (memória `stack-e2e-abac-ligado`).
  country: 'AR',
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

// ── DB helpers ────────────────────────────────────────────────────────────────

// `E2E_PG_CONTAINER` permite apontar para um stack isolado por projeto docker
// (mesmo padrão de `db-test-helper.ts:20`) — sem isso este arquivo só roda contra o
// container fixo `enlite-postgres`, que pode estar servindo OUTRA worktree.
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

function setPatientCaseNumber(patientId: string, caseNumber: number): void {
  runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
}

// ── Mock interceptors ─────────────────────────────────────────────────────────

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
      body: JSON.stringify({
        users: [
          {
            localId: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            emailVerified: true,
          },
        ],
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
            firstName: 'EditRouting',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/publish-talentum')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
      return;
    }

    const headers = {
      ...route.request().headers(),
      authorization: `Bearer ${MOCK_TOKEN}`,
    };
    await route.continue({ headers });
  });

  // `/v1/me/authz` (o contrato que `AdminProtectedRoute`/`useAdminAuthStore` esperam antes de
  // liberar a tela — achado ao rodar Fase 3 contra um stack isolado, `docker-compose -p`, F8)
  // é um path DIFERENTE de `/api/**` e não era coberto aqui — sem isso o request saía com o
  // `FAKE_ID_TOKEN` cru, o backend recusava, e a página ficava presa num loop de retry/remount
  // (skeleton pra sempre, `edit-vacancy-*`/`vacancy-row-*` nunca aparecem). Mesmo padrão de
  // `abac-stack-helper.ts`, que já cobre isto — mas ESTRITO em `**/v1/me/authz`, nunca
  // `**/v1/**`: `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` também bate
  // em `/v1/`, e um catch-all genérico rouba a interceptação já registrada pra ele (Playwright
  // resolve rota sobreposta pela ÚLTIMA registrada), fazendo o login de verdade sair pro
  // Google com header forjado → 401 real, `not toHaveURL(login)` nunca passa (achado medido
  // rodando este arquivo contra um stack isolado antes deste ajuste).
  await page.route('**/v1/me/authz', async (route: Route) => {
    const headers = {
      ...route.request().headers(),
      authorization: `Bearer ${MOCK_TOKEN}`,
    };
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

// ── Test Suite ────────────────────────────────────────────────────────────────

test.describe('AdminVacanciesPage — edit routing por is_draft @integration', () => {
  test.setTimeout(120_000);

  let patientId = '';
  let addressId = '';
  let draftVacancyId = '';
  let nonDraftVacancyId = '';
  let caseNumber = 0;

  test.beforeAll(() => {
    caseNumber = 980_000 + Math.floor(Math.random() * 9999);
    const patient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'EditRouting',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = patient.patientId;
    addressId = patient.addressId ?? '';
    setPatientCaseNumber(patientId, caseNumber);

    // Vaga rascunho (is_draft = true) — modal grande deve abrir
    draftVacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'PENDING_ACTIVATION',
      isDraft: true,
    });

    // Vaga publicada non-draft em SEARCHING_REPLACEMENT — deve redirecionar para o detalhe
    nonDraftVacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'SEARCHING_REPLACEMENT',
      isDraft: false,
    });

    // Garante meet_link e schedule pra o detalhe não estourar
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          schedule = '[{"dayOfWeek": 5, "startTime": "16:30", "endTime": "18:30"}]'::jsonb
      WHERE id = '${nonDraftVacancyId}'
    `);

    // Mesma hidratação para a draft — o cenário 4 abre o modal grande e submete,
    // e o schema Zod exige schedule + meet_link válidos. Sem isso, o submit nem
    // chega ao PUT (validation barra antes) e a defesa do 403 não é exercitada.
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          schedule = '[{"dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00"}]'::jsonb,
          providers_needed = 1
      WHERE id = '${draftVacancyId}'
    `);
  });

  test.afterAll(() => {
    cleanupVacancies([draftVacancyId, nonDraftVacancyId]);
    cleanupTestPatient(patientId);
  });

  // ── Cenário 1: non-draft → clique na linha navega pro detalhe, sem dialog ────

  test('1. clique na linha non-draft (SEARCHING_REPLACEMENT) → navega pro detalhe, nenhum dialog no DOM', async ({ page }) => {
    test.skip(!nonDraftVacancyId, 'Could not seed non-draft vacancy');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');

    // Lápis SAIU da lista (F25/D425) — a linha inteira é o alvo do clique agora.
    await expect(page.getByTestId(`edit-vacancy-${nonDraftVacancyId}`)).toHaveCount(0);
    const row = page.getByTestId(`vacancy-row-${nonDraftVacancyId}`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.click();

    // ── Deve navegar pra /admin/vacancies/{id} ───────────────────────────────
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${nonDraftVacancyId}(?!/edit)`),
      { timeout: 10_000 },
    );

    // ── Nenhum modal/dialog deve estar visível ──────────────────────────────
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-modal')).toHaveCount(0);

    // ── Screenshot do detalhe (regressão visual) ────────────────────────────
    await expect(page).toHaveScreenshot('non-draft-redirected-to-detail.png', {
      fullPage: false,
      maxDiffPixels: 10_000,
    });
  });

  // ── Cenário 2: draft → clique na linha abre o DraftVacancyChoiceDialog ───

  test('2. clique na linha draft (PENDING_ACTIVATION, is_draft=true) → abre o DraftVacancyChoiceDialog', async ({ page }) => {
    test.skip(!draftVacancyId, 'Could not seed draft vacancy');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');

    // Lápis SAIU (F25/D425); o badge de rascunho é o controle de que a linha carregou.
    await expect(page.getByTestId(`edit-vacancy-${draftVacancyId}`)).toHaveCount(0);
    const badge = page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`);
    await expect(badge).toBeVisible({ timeout: 20_000 });

    await badge.click();

    // ── O DraftVacancyChoiceDialog DEVE abrir (engine ABAC off neste stack →
    //    useActionGate sempre allowed=true, F8/useCellAccess.ts:70) ──────────
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('choice-complete')).toBeVisible();
    await expect(page.getByTestId('choice-view')).toBeVisible();

    // ── NÃO deve ter navegado pra fora da listagem ──────────────────────────
    await expect(page).toHaveURL(/\/admin\/vacancies(?:\?|$)/);
  });

  // ── Cenário 3: salvar schedule em non-draft via detalhe NÃO retorna 403 ──

  test('3. salvar schedule no detalhe de vaga non-draft NÃO retorna 403 — endpoint aceita { schedule }', async ({ page }) => {
    test.skip(!nonDraftVacancyId, 'Could not seed non-draft vacancy');

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${nonDraftVacancyId}`);

    // Aguarda a página de detalhe carregar
    await expect(page.getByText(/Días y Horarios|Días y horarios|Horarios/i).first())
      .toBeVisible({ timeout: 20_000 });

    // Procura o lápis ao lado de "Días y Horarios" e abre o VacancyScheduleEditModal
    const scheduleEditTrigger = page.getByTestId('vacancy-edit-schedule-trigger');
    await expect(scheduleEditTrigger).toBeVisible({ timeout: 10_000 });
    await scheduleEditTrigger.click();

    const scheduleModal = page.getByTestId('vacancy-schedule-modal');
    await expect(scheduleModal).toBeVisible({ timeout: 10_000 });

    // Clica em "Guardar" — escuta a resposta do PUT pra confirmar status 200
    const putResponse = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/admin/vacancies/${nonDraftVacancyId}`) &&
        res.request().method() === 'PUT',
      { timeout: 15_000 },
    );

    await page.getByTestId('vacancy-schedule-save').click();
    const res = await putResponse;

    // ── Status DEVE ser 200, NÃO 403 ─────────────────────────────────────────
    expect(res.status()).toBe(200);
  });

  // Nota: a defesa do 403 no submit (VacancyFormSection.onSubmit interceptando
  // "Forbidden fields" e redirecionando para o detalhe) é coberta por unit test
  // em VacancyFormSection.defense.test.tsx — mockar updateVacancy pra retornar
  // 403 sem precisar passar pelo schema Zod do form completo é mais reliable.
});

// ── Backend connectivity ─────────────────────────────────────────────────────

test.describe('Backend health (edit-routing) @integration', () => {
  test.setTimeout(10_000);

  test('backend health endpoint returns OK', async ({ request }) => {
    const res = await request.get('http://localhost:8080/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('healthy');
  });
});
