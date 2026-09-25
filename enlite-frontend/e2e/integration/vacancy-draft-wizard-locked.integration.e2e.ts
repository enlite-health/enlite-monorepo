/**
 * vacancy-draft-wizard-locked.integration.e2e.ts @integration — fase 4,
 * `openspec/changes/completar-vacante-em-rascunho/fase-4.md`.
 *
 * O assunto desta fase NÃO é permissão (o engine ABAC pode ficar OFF) — stack padrão desta
 * worktree (isolada por projeto docker `cv-fase4`, ver `docker-compose.fase4.local.yml` em
 * `worker-functions/`), login por UI real (molde `full-create-vacancy.integration.e2e.ts`).
 *
 * Mocks (ÚNICOS, mesmo molde de `full-create-vacancy.integration.e2e.ts` — "Custo de API = zero"
 * e "Teste nunca toca canal real", CLAUDE.md): Firebase Identity Toolkit, `/api/admin/auth/profile`,
 * `/generate-ai-content` (Gemini custaria), `/publish-talentum` (canal real proibido),
 * `/meet-links/lookup` (Google Calendar). GET/PUT de vacante, serviço contratado e o foguete são
 * o backend REAL — nenhum mock neles, exceto a sabotagem do teste 5 (`page.route` reintroduzindo
 * `schedule` travado no body), que é o único ponto onde a doc pede isso.
 *
 * Fixture: 1 paciente + endereço, 1 serviço contratado ativado pelo foguete (mesmo caminho de
 * `vacancy-locked-fields.integration.e2e.ts`, fase 1) — a vaga nasce `is_draft=true` com
 * `contracted_service_id` setado, então `locked_fields` do GET traz os 8 nomes.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient, backdateVacancyUpdatedAt } from '../helpers/db-test-helper';

const BACKEND_URL = process.env.API_BASE_URL || 'http://localhost:8100';

// `country` é OBRIGATÓRIO no claim mock (memória `stack-e2e-abac-ligado`): sem ele, o trigger
// `fn_patient_contracted_services_country_from_patient` (migration 319) faz `SELECT p.country
// FROM patients p WHERE p.id = NEW.patient_id` sob RLS que filtra por país do ator — sem claim,
// a query devolve ZERO linhas (sem fallback), `NEW.country` fica NULL e o INSERT quebra por
// `NOT NULL` (medido: 500 "Failed to create contracted service" até adicionar isto).
const MOCK_ADMIN_USER = {
  uid: 'e2e-int-draft-wizard-locked',
  email: 'admin.draftwizardlocked@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');
const AUTH_HEADERS = { Authorization: `Bearer ${MOCK_TOKEN}`, 'Content-Type': 'application/json' };

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

// ── Mock interceptors (mesmo molde de full-create-vacancy.integration.e2e.ts) ──────────────
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
          data: {
            description: 'Se busca Acompañante Terapéutico.',
            prescreening: { questions: [], faq: [] },
          },
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
          data: { projectId: 'fake-project-id', publicId: '00000000-0000-0000-0000-000000000000', slug: 'fase-4-vacancy', whatsappUrl: 'https://wa.me/fake' },
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

  // `/v1/me/authz` (o contrato ABAC, mesmo com engine OFF o front chama) fica FORA de `/api/**`
  // — sem esta 2ª rota o token fake do Firebase vaza pra lá e vira 401 mudo (medido).
  await page.route('**/api/**', backendRouteHandler);
  await page.route('**/v1/me/authz', backendRouteHandler);
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

test.describe('draft-wizard-locked — fase 4 (completar-vacante-em-rascunho) @integration', () => {
  // Os testes compartilham 1 vaga-rascunho (fixture única, molde de vacancy-locked-fields.
  // integration.e2e.ts) — serial evita a corrida de `fullyParallel` sobre a mesma linha.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let addressId = '';
  let serviceId = '';
  let draftVacancyId = '';

  test.beforeAll(async ({ request }) => {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'DraftWizardLocked',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();

    // Serviço contratado pela API real + foguete real (mesmo endpoint que "Lançar" chama) — a
    // vaga nasce com contracted_service_id setado, então locked_fields traz os 8 nomes (F3).
    const svcRes = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT',
        providersNeeded: 1,
        weeklyHours: 20,
        careLocation: 'HOME',
        addressId,
        schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      },
    });
    expect(svcRes.ok(), `POST contracted-services falhou: ${svcRes.status()} ${await svcRes.text()}`).toBe(true);
    serviceId = (await svcRes.json()).data.id as string;

    const activateRes = await request.post(
      `${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      { headers: AUTH_HEADERS },
    );
    expect(activateRes.ok(), `activate-recruitment falhou: ${activateRes.status()} ${await activateRes.text()}`).toBe(true);
    draftVacancyId = (await activateRes.json()).data.vacancyId as string;

    // `formatDateTime` mostra só até o MINUTO — sem recuar o "antes", o round-trip do
    // teste 1 (segundos) faz o texto de "Última edición" bater por granularidade, não
    // por falta de persistência. Recua 1 dia para o depois divergir de verdade.
    backdateVacancyUpdatedAt(draftVacancyId, 1);
  });

  test.afterAll(() => cleanupTestPatient(patientId));

  test('1. feliz — campos travados disabled; Continuar persiste e is_draft segue true', async ({ page, request }) => {
    await loginAsAdmin(page);

    // "Última edición" ANTES — via /borrador (Fase 2), prova a Retomada (item 4 do "O que
    // implementa") pelo botão "Completar vacante" em vez de goto direto no /edit.
    await page.goto(`/admin/vacancies/${draftVacancyId}/borrador`);
    await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible({ timeout: 15_000 });
    const lastUpdatedBefore = (await page.getByTestId('vacancy-last-updated').textContent()) ?? '';
    expect(lastUpdatedBefore).toBeTruthy();

    const [getResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/admin/vacancies/${draftVacancyId}`) && r.request().method() === 'GET'),
      page.getByTestId('complete-vacancy-btn').click(),
    ]);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/edit$`));

    // locked_fields LIDO DO GET NA MESMA EXECUÇÃO — nunca uma lista escrita neste arquivo.
    const getData = (await getResp.json()).data;
    const lockedFields: string[] = getData.locked_fields;
    const updatedAtBefore: string = getData.updated_at;
    expect(new Set(lockedFields)).toEqual(
      new Set(['case_number', 'patient_id', 'patient_address_id', 'contracted_service_id', 'age_range_min', 'age_range_max', 'schedule', 'providers_needed']),
    );

    // Os 4 grupos com campo de FORM (patient_address_id, age_range_*, schedule, providers_needed)
    // nascem `disabled`, com o link "Editar en la ficha del paciente" ao lado.
    await expect(page.getByTestId(`address-option-${addressId}`)).toBeDisabled();
    await expect(page.getByTestId('locked-field-link-address')).toBeVisible();
    await expect(page.getByTestId('age-range-select')).toBeDisabled();
    await expect(page.getByTestId('locked-field-link-age-range')).toBeVisible();
    await expect(page.getByTestId('providers-needed-input')).toBeDisabled();
    await expect(page.getByTestId('locked-field-link-providers')).toBeVisible();
    await expect(page.getByTestId('vacancy-schedule-add-lun')).toBeDisabled();
    await expect(page.getByTestId('locked-field-link-schedule')).toBeVisible();

    // Dependia do fix de `buildScheduleFromVacancy` (#526, na stage).

    // Preenche profissão + valor por hora — os dois campos livres que o recrutamento completa.
    // O input real é `sr-only` (Checkbox atom): quem recebe o clique de um humano de verdade é o
    // `<label for="profession-AT">` que envolve o box visível + o texto — clicar nele, não no
    // input escondido, é o mesmo alvo que um dedo/mouse acertaria na tela.
    await page.locator('label[for="profession-AT"]').click();
    await expect(page.getByTestId('profession-checkbox-AT')).toBeChecked();
    // salary_text já vem "A convenir" (F2: é o "vazio" que o foguete grava, nunca NULL) — um
    // humano que for trocar o valor seleciona tudo e digita por cima, não faz `.fill('')`.
    const salaryInput = page.getByTestId('salary-text-input');
    await salaryInput.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('$5000');
    await expect(salaryInput).toHaveValue('$5000');

    const meetInput = page.getByTestId('meet-link-0');
    await meetInput.click();
    await page.keyboard.type('meet.google.com/abc-defg-hij');
    await meetInput.blur();

    const saveBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await saveBtn.click();
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 30_000 });

    const verifyRes = await request.get(`${BACKEND_URL}/api/admin/vacancies/${draftVacancyId}`, { headers: AUTH_HEADERS });
    const verified = (await verifyRes.json()).data;
    expect(verified.required_professions).toEqual(['AT']);
    expect(verified.salary_text).toBe('$5000');
    expect(verified.is_draft).toBe(true);
    // Prova de verdade da persistência — `updated_at` BRUTO da API, não o texto da UI
    // (que só mostra até o minuto): o GET pós-save tem que ser mais recente que o de antes.
    expect(new Date(verified.updated_at).getTime()).toBeGreaterThan(new Date(updatedAtBefore).getTime());

    // "Última edición" DEPOIS — muda em relação ao "antes" (garantido pelo recuo de 1 dia
    // no `beforeAll`; sem ele o round-trip local caberia no mesmo minuto exibido).
    await page.goto(`/admin/vacancies/${draftVacancyId}/borrador`);
    const lastUpdatedAfter = (await page.getByTestId('vacancy-last-updated').textContent()) ?? '';
    expect(lastUpdatedAfter).toBeTruthy();
    expect(lastUpdatedAfter).not.toBe(lastUpdatedBefore);
  });

  test('2. alternativo 1 — sai sujo: digitar em "Perfil", clicar Volver → dialog; confirmar → GET não tem o valor, URL é /borrador', async ({ page, request }) => {
    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${draftVacancyId}/edit`);
    await expect(page.getByTestId('worker-attributes-textarea')).toBeVisible({ timeout: 15_000 });

    const dirtyValue = 'Prefiere trato cálido y paciencia con adultos mayores';
    const textarea = page.getByTestId('worker-attributes-textarea');
    await textarea.click();
    await page.keyboard.type(dirtyValue);
    await expect(textarea).toHaveValue(dirtyValue);

    await page.getByTestId('vacancy-wizard-back-btn').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('guardar');

    await page.getByTestId('unsaved-changes-confirm').click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));

    const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${draftVacancyId}`, { headers: AUTH_HEADERS });
    const body = (await res.json()).data;
    expect(body.worker_attributes ?? null).not.toBe(dirtyValue);
  });

  test('3. alternativo 2 — sai limpo: abrir e clicar Volver sem digitar → nenhum dialog, URL é /borrador', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${draftVacancyId}/edit`);
    await expect(page.getByTestId('vacancy-wizard-back-btn')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByTestId('vacancy-wizard-back-btn').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
  });

  test('4. body do PUT sem campo travado — Object.keys(body) ∩ locked_fields = []', async ({ page, request }) => {
    // Dependia do fix de `buildScheduleFromVacancy` (#526, na stage).
    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${draftVacancyId}/edit`);
    await expect(page.getByTestId('create-vacancy-save-btn')).toBeEnabled({ timeout: 15_000 });

    // `undefined` = nenhum PUT interceptado ainda; `null` = PUT chegou mas o body não era
    // JSON (falha de verdade — antes virava `{}` e passava calado, medindo interseção vazia
    // sem nunca ter olhado o body real); objeto = parse ok.
    let capturedBody: Record<string, unknown> | null | undefined = undefined;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/api/admin/vacancies/${draftVacancyId}`)) {
        try {
          capturedBody = JSON.parse(req.postData() ?? '{}');
        } catch {
          capturedBody = null;
        }
      }
    });

    const lockedRes = await request.get(`${BACKEND_URL}/api/admin/vacancies/${draftVacancyId}`, { headers: AUTH_HEADERS });
    const lockedFields: string[] = (await lockedRes.json()).data.locked_fields;

    await page.getByTestId('create-vacancy-save-btn').click();
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 30_000 });

    expect(capturedBody, 'nenhum PUT capturado — o save não disparou request nenhum').not.toBeUndefined();
    expect(capturedBody, 'body do PUT não era JSON').not.toBeNull();
    const bodyKeys = Object.keys(capturedBody ?? {});
    const intersection = bodyKeys.filter((k) => lockedFields.includes(k));
    console.log(`body keys: ${JSON.stringify(bodyKeys)} · locked_fields: ${JSON.stringify(lockedFields)} · interseção: ${JSON.stringify(intersection)}`);
    expect(intersection).toEqual([]);
  });

  test('5. sabotagem — page.route força "schedule" no body do PUT → 422 e o valor não muda', async ({ page, request }) => {
    // Dependia do fix de `buildScheduleFromVacancy` (#526, na stage).
    await loginAsAdmin(page);

    const before = await request.get(`${BACKEND_URL}/api/admin/vacancies/${draftVacancyId}`, { headers: AUTH_HEADERS });
    const scheduleBefore = (await before.json()).data.schedule;

    await page.goto(`/admin/vacancies/${draftVacancyId}/edit`);
    await expect(page.getByTestId('create-vacancy-save-btn')).toBeEnabled({ timeout: 15_000 });

    let putStatus: number | null = null;
    await page.route(`**/api/admin/vacancies/${draftVacancyId}`, async (route: Route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }
      const original = JSON.parse(route.request().postData() ?? '{}');
      const sabotaged = { ...original, schedule: [{ dayOfWeek: 5, startTime: '18:00', endTime: '22:00' }] };
      const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
      const resp = await route.fetch({ headers, postData: JSON.stringify(sabotaged) });
      putStatus = resp.status();
      await route.fulfill({ response: resp });
    });

    await page.getByTestId('create-vacancy-save-btn').click();
    // O 422 impede o onSuccess/navigate — a tela fica no /edit e mostra o erro da API.
    await expect(page.locator('text=/travad/i')).toBeVisible({ timeout: 15_000 });
    expect(putStatus).toBe(422);

    const after = await request.get(`${BACKEND_URL}/api/admin/vacancies/${draftVacancyId}`, { headers: AUTH_HEADERS });
    const scheduleAfter = (await after.json()).data.schedule;
    console.log(`sabotagem — status=${putStatus} · schedule antes=${JSON.stringify(scheduleBefore)} · depois=${JSON.stringify(scheduleAfter)}`);
    expect(scheduleAfter).toEqual(scheduleBefore);
  });
});
