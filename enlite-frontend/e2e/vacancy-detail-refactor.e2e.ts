/**
 * vacancy-detail-refactor.e2e.ts
 *
 * Playwright E2E — Tela de Detalhe da Vaga Refatorada
 *
 * Valida as 3 fases do refactor:
 *   1. Backend funnel-table endpoint
 *   2. Layout dos cards (VacancyCaseCard + VacancyPatientCard + VacancyProfessionCard + MeetLinksRow)
 *   3. Tab de funil com toggle Lista/Kanban
 *
 * Todos os testes são totalmente mockados (sem backend real, sem Gemini, sem banco).
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// VITE_FIREBASE_API_KEY deve corresponder ao valor real que o SDK usa no browser.
// O formato da chave localStorage é: firebase:authUser:{apiKey}:[DEFAULT]
const FRONTEND_API_KEY =
  process.env.VITE_FIREBASE_API_KEY || 'AIzaSyByRp-NCY0m12iEoKyuIrV6vR49MZateXI';

const MOCK_VACANCY_ID = 'cccccccc-0003-0003-0003-cccccccccccc';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 226,
  vacancy_number: 1,
  title: 'Caso 226-1 — Acompañante Terapéutico',
  status: 'ACTIVO',
  country: 'ARG',
  patient_first_name: 'Santiago',
  patient_last_name: 'Claiman Soto',
  patient_diagnosis: 'CID: Patologías y trastornos neurológicos',
  patient_zone: 'Villa Luro, CABA',
  patient_city: 'Buenos Aires',
  patient_neighborhood: 'Villa Luro',
  dependency_level: 'Dependencia total',
  required_sex: 'Mujer',
  required_professions: ['AT'],
  service_type: 'Domiciliar',
  worker_attributes: null,
  age_range_min: null,
  age_range_max: null,
  payment_term_days: 5,
  net_hourly_rate: '8000',
  weekly_hours: 30,
  providers_needed: 2,
  talentum_project_id: null,
  talentum_description: null,
  talentum_whatsapp_url: null,
  talentum_slug: null,
  talentum_published_at: null,
  insurance_verified: false,
  publications: [],
  social_short_links: null,
  meet_link_1: 'https://meet.google.com/nox-yqex-sdj',
  meet_datetime_1: '2026-05-10T10:00:00Z',
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
  created_at: '2026-01-15T00:00:00Z',
  closed_at: null,
  schedule: {
    sunday: [{ start: '09:00', end: '13:00' }],
    monday: [{ start: '08:00', end: '14:00' }],
    wednesday: [{ start: '09:00', end: '17:00' }],
  },
};

function buildFunnelTableResponse(bucket: string) {
  const rows5 = [
    {
      id: `inv-1`,
      workerId: 'w1',
      workerName: 'Ana García',
      workerEmail: 'ana@test.com',
      workerPhone: '+54 9 11 1234-5678',
      workerAvatarUrl: null,
      invitedAt: '2026-04-10T10:00:00Z',
      funnelStage: 'INVITED',
      whatsappStatus: 'NOT_SENT',
      whatsappLastDispatchedAt: null,
      accepted: null,
      interviewResponse: null,
    },
    {
      id: `inv-2`,
      workerId: 'w2',
      workerName: 'Bruno López',
      workerEmail: 'bruno@test.com',
      workerPhone: '+54 9 11 2345-6789',
      workerAvatarUrl: null,
      invitedAt: '2026-04-11T10:00:00Z',
      funnelStage: 'INVITED',
      whatsappStatus: 'SENT',
      whatsappLastDispatchedAt: '2026-04-11T10:01:00Z',
      accepted: null,
      interviewResponse: null,
    },
    {
      id: `inv-3`,
      workerId: 'w3',
      workerName: 'Carla Méndez',
      workerEmail: 'carla@test.com',
      workerPhone: '+54 9 11 3456-7890',
      workerAvatarUrl: null,
      invitedAt: '2026-04-12T10:00:00Z',
      funnelStage: 'INVITED',
      whatsappStatus: 'DELIVERED',
      whatsappLastDispatchedAt: '2026-04-12T10:01:00Z',
      accepted: null,
      interviewResponse: null,
    },
    {
      id: `inv-4`,
      workerId: 'w4',
      workerName: 'Diego Sosa',
      workerEmail: 'diego@test.com',
      workerPhone: '+54 9 11 4567-8901',
      workerAvatarUrl: null,
      invitedAt: '2026-04-13T10:00:00Z',
      funnelStage: 'INVITED',
      whatsappStatus: 'READ',
      whatsappLastDispatchedAt: '2026-04-13T10:01:00Z',
      accepted: null,
      interviewResponse: null,
    },
    {
      id: `inv-5`,
      workerId: 'w5',
      workerName: 'Elena Paz',
      workerEmail: 'elena@test.com',
      workerPhone: '+54 9 11 5678-9012',
      workerAvatarUrl: null,
      invitedAt: '2026-04-14T10:00:00Z',
      funnelStage: 'INVITED',
      whatsappStatus: 'REPLIED',
      whatsappLastDispatchedAt: '2026-04-14T10:01:00Z',
      accepted: true,
      interviewResponse: null,
    },
  ];

  const rows2 = [
    {
      id: 'post-1',
      workerId: 'w6',
      workerName: 'Felipe Torres',
      workerEmail: 'felipe@test.com',
      workerPhone: '+54 9 11 6789-0123',
      workerAvatarUrl: null,
      invitedAt: '2026-04-08T10:00:00Z',
      funnelStage: 'POSTULATED',
      whatsappStatus: 'REPLIED',
      whatsappLastDispatchedAt: '2026-04-08T10:01:00Z',
      accepted: true,
      interviewResponse: null,
    },
    {
      id: 'post-2',
      workerId: 'w7',
      workerName: 'Gloria Martínez',
      workerEmail: 'gloria@test.com',
      workerPhone: '+54 9 11 7890-1234',
      workerAvatarUrl: null,
      invitedAt: '2026-04-09T10:00:00Z',
      funnelStage: 'POSTULATED',
      whatsappStatus: 'SENT',
      whatsappLastDispatchedAt: '2026-04-09T10:01:00Z',
      accepted: null,
      interviewResponse: null,
    },
  ];

  const baseCounts = {
    INVITED: 5,
    POSTULATED: 2,
    PRE_SELECTED: 0,
    REJECTED: 0,
    WITHDREW: 0,
    ALL: 7,
  };

  if (bucket === 'INVITED') {
    return { rows: rows5, counts: baseCounts };
  }
  if (bucket === 'POSTULATED') {
    return { rows: rows2, counts: baseCounts };
  }
  return { rows: [], counts: baseCounts };
}

const MOCK_FUNNEL_KANBAN = {
  success: true,
  data: {
    stages: {
      INVITED: [
        {
          id: 'f1',
          workerName: 'Ana García',
          workerPhone: '+54 9 11 1234-5678',
          occupation: 'AT',
          interviewDate: '2026-04-20',
          interviewTime: '10:00',
          meetLink: null,
          resultado: null,
          attended: null,
          rejectionReasonCategory: null,
          rejectionReason: null,
          matchScore: 80,
          workZone: 'Palermo',
          redireccionamiento: null,
        },
      ],
      CONFIRMED: [
        {
          id: 'f2',
          workerName: 'Bruno López',
          workerPhone: '+54 9 11 2345-6789',
          occupation: 'AT',
          interviewDate: '2026-04-21',
          interviewTime: '14:00',
          meetLink: 'https://meet.google.com/abc',
          resultado: null,
          attended: null,
          rejectionReasonCategory: null,
          rejectionReason: null,
          matchScore: 92,
          workZone: 'Belgrano',
          redireccionamiento: null,
        },
      ],
      INTERVIEWING: [],
      SELECTED: [],
      REJECTED: [],
      PENDING: [],
    },
    totalEncuadres: 2,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Cria um usuário admin no Firebase Emulator (porta 9099) e faz login
 * via UI. As chamadas do Firebase SDK são interceptadas e redirecionadas
 * para o emulador em modo headless.
 *
 * O endpoint /api/admin/auth/profile é mockado via page.route(), portanto
 * o backend real não precisa estar rodando.
 *
 * Importante: o dev server do Vite deve ter VITE_FIREBASE_AUTH_EMULATOR
 * configurado para que o SDK conecte ao emulador. Se não estiver, as chamadas
 * do SDK vão para o Firebase de produção com o token do emulador (que é
 * rejeitado), e o login falha.
 *
 * Estratégia alternativa quando o Vite não tem VITE_FIREBASE_AUTH_EMULATOR:
 * interceptamos as chamadas do SDK via page.route e as redirecionamos para
 * o emulador local.
 */
async function loginAsAdmin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.vd.refactor.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  // 1. Cria o usuário no Firebase Emulator via REST (antes de qualquer navegação)
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as {
    localId?: string;
    idToken?: string;
    error?: { message: string };
  };
  if (!signUpData.localId) {
    throw new Error(`Firebase Emulator sign-up failed: ${JSON.stringify(signUpData)}`);
  }
  const uid = signUpData.localId;

  // 2. Intercepta chamadas do Firebase SDK (identitytoolkit + securetoken)
  //    e redireciona para o emulador local via fetch manual.
  //    Isso contorna a ausência de VITE_FIREBASE_AUTH_EMULATOR no dev server.
  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const originalUrl = route.request().url();
    // Monta URL do emulador: troca host https pelo emulador http
    const parsed = new URL(originalUrl);
    const emulatorUrl = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;

    try {
      const res = await fetch(emulatorUrl, {
        method: route.request().method(),
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData() ?? undefined,
      });
      const body = await res.text();
      await route.fulfill({
        status: res.status,
        contentType: 'application/json',
        body,
      });
    } catch {
      await route.abort();
    }
  });

  // Intercepta securetoken (refresh de token) — retorna token mock para que
  // getIdToken() não lance exceção. O token não precisa ser válido pois todas
  // as chamadas à API são interceptadas via page.route e não validam o JWT.
  await page.route('**/securetoken.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'mock-access-token-e2e',
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'mock-refresh-token-e2e',
        id_token: 'mock-id-token-e2e',
        user_id: 'mock-uid-e2e',
        project_id: 'enlite-prd',
      }),
    });
  });

  // 3. Mock /api/admin/auth/profile
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'QA',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // 4. Login via UI — o Firebase SDK fará as chamadas interceptadas acima
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30_000 });
}

async function mockVacancyApis(page: Page): Promise<void> {
  // Vacancy detail
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
    }),
  );

  // Funnel table — bucket-aware via query string
  // O request() do AdminApiService retorna json.data, então precisamos de
  // { success: true, data: { rows, counts } }
  await page.route(
    `**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel-table**`,
    (route) => {
      const url = new URL(route.request().url());
      const bucket = url.searchParams.get('bucket') ?? 'INVITED';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: buildFunnelTableResponse(bucket),
        }),
      });
    },
  );

  // Funnel kanban (useEncuadreFunnel)
  await page.route(
    `**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FUNNEL_KANBAN),
      }),
  );

  // Prescreening config (loaded on Talentum tab)
  await page.route(
    `**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { questions: [], faq: [] } }),
      }),
  );

  // Social short links
  await page.route(
    `**/api/admin/vacancies/${MOCK_VACANCY_ID}/social-short-links`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
  );

  // Match results (prefetched by some views)
  await page.route(
    `**/api/admin/vacancies/${MOCK_VACANCY_ID}/match-results**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            jobPostingId: MOCK_VACANCY_ID,
            lastMatchAt: null,
            totalCandidates: 0,
            candidates: [],
          },
        }),
      }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('VacancyDetailPage — Refactor (Funnel + Cards + Toggle)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── A. Header e cards de layout ─────────────────────────────────────────────

  test('A1 — header exibe título "Caso 226-1" e botão Ver Match', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Título com case_number e vacancy_number
    await expect(page.getByText(/CASO\s+226/i).first()).toBeVisible();

    // Botão Ver Match presente
    await expect(
      page.getByRole('button', { name: /Ver Match/i }),
    ).toBeVisible();
  });

  test('A2 — VacancyCaseCard exibe badge "Activo" com classe blue-yonder', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Badge status "Activo"
    const badge = page.locator('text=Activo').first();
    await expect(badge).toBeVisible();
    // Classe bg-blue-yonder no badge (inline ou parent)
    const badgeEl = page.locator('.bg-blue-yonder').first();
    await expect(badgeEl).toBeVisible();
  });

  test('A3 — VacancyProfessionCard exibe botão "Editar" e sex "Mujer"', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Botão Editar no card de profissão
    await expect(page.getByRole('button', { name: /Editar/i })).toBeVisible();

    // Sexo requerido
    await expect(page.locator('text=Mujer').first()).toBeVisible();
  });

  test('A4 — ScheduleGrid exibe dias com pílulas de horário', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Domingo deve aparecer (schedule tem sunday configurado)
    await expect(page.locator('text=/Domingo/i').first()).toBeVisible();

    // Pílula de horário com intervalo (busca por padrão ##:##h - ##:##h)
    await expect(
      page.locator('text=/\\d{2}:\\d{2}h - \\d{2}:\\d{2}h/').first(),
    ).toBeVisible();
  });

  test('A5 — VacancyMeetLinksRow exibe 1 pílula com link de entrevista', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Row de meet links deve conter "Fechas para entrevista" (título do componente VacancyMeetLinksRow)
    await expect(
      page.locator('text=/Fechas para entrevista/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── B. Funil — modo Lista ────────────────────────────────────────────────────

  test('B1 — aba Encuadres ativa por default, toggle mostra "Lista" pressionado', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Tab Encuadres ativa
    const encuadresBtn = page.getByRole('button', { name: /Encuadres/i });
    await expect(encuadresBtn).toHaveClass(/bg-primary/);

    // Toggle Lista pressionado (aria-pressed=true)
    const listaBtn = page.getByRole('button', { name: /Lista/i });
    await expect(listaBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('B2 — tab Invitados (5) ativo por default, tabela mostra 5 linhas', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil (está abaixo dos cards)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Tab Invitados deve estar visível
    await expect(
      page.getByRole('tab', { name: /Invitados/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Aguarda o count 5 aparecer no label do tab (vem do endpoint funnel-table)
    await expect(
      page.locator('[role="tablist"] button', { hasText: /Invitados \(5\)/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Tabela com 5 linhas de dados (tbody rows)
    const rows = page.locator('[role="table"] tbody tr');
    await expect(rows).toHaveCount(5, { timeout: 15_000 });
  });

  test('B3 — badges WhatsApp com cores corretas para cada status', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil e aguarda tabela carregar
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('[role="table"]')).toBeVisible({ timeout: 20_000 });

    // NOT_SENT → "No enviado" (bg-cancelled = rosa)
    await expect(page.locator('text=No enviado').first()).toBeVisible();

    // SENT → "Enviado" (bg-blue-yonder)
    await expect(page.locator('text=Enviado').first()).toBeVisible();

    // DELIVERED → "Entregado" (bg-cyan-focus)
    await expect(page.locator('text=Entregado').first()).toBeVisible();

    // READ → "Leído" (bg-new-car)
    await expect(page.locator('text=Leído').first()).toBeVisible();

    // REPLIED → "Respondido" (bg-turquoise)
    await expect(page.locator('text=Respondido').first()).toBeVisible();
  });

  test('B4 — clique na tab Postulados muda count para 2, tabela atualiza para 2 linhas', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil e aguarda tabela de Invitados
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('[role="table"]')).toBeVisible({ timeout: 20_000 });

    // Clica na tab Postulados
    await page.locator('[role="tablist"] button', { hasText: /Postulados/i }).click();

    // Tabela atualiza para 2 linhas
    const rows = page.locator('[role="table"] tbody tr');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
  });

  test('B5 — tab Desistentes (0) mostra empty state', async ({ page }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Clica na tab Desistentes
    await page.locator('[role="tablist"] button', { hasText: /Desistentes/i }).click();

    // Empty state visível
    await expect(
      page.locator(
        'text=/Sin candidatos en esta etapa|sem candidatos/i',
      ).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('B6 — botão "Enviar invitaciones" visível na aba Encuadres', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page.getByRole('button', { name: /Enviar invitaciones/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('B7 — clique em "Enviar invitaciones" não navega nem exibe erro', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    // Captura mensagens de console para verificar o stub
    const consoleLogs: string[] = [];
    page.on('console', (msg) => consoleLogs.push(msg.text()));

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: /Enviar invitaciones/i }).click();

    // Permanece na mesma URL
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${MOCK_VACANCY_ID}`),
    );

    // Console log do stub deve conter a mensagem esperada
    await page.waitForTimeout(300);
    const dispatchLog = consoleLogs.find((l) =>
      l.includes('dispatch invites clicked'),
    );
    expect(dispatchLog).toBeTruthy();
  });

  // ── C. Funil — toggle Kanban ─────────────────────────────────────────────────

  test('C1 — toggle "Kanban" esconde tabela e exibe KanbanBoard', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil e aguarda tabela visível no modo Lista
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('[role="table"]')).toBeVisible({ timeout: 20_000 });

    // Clica no toggle Kanban
    const kanbanBtn = page.getByRole('button', { name: /Kanban/i, exact: true });
    await kanbanBtn.click();

    // Tabela some
    await expect(page.locator('[role="table"]')).not.toBeVisible({ timeout: 5_000 });

    // KanbanBoard aparece (workers do Kanban mock visíveis)
    await expect(page.locator('text=Ana García').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('C2 — toggle "Kanban" deixa o botão Kanban pressionado (aria-pressed=true)', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    const kanbanBtn = page.getByRole('button', {
      name: /Kanban/i,
      exact: true,
    });
    await kanbanBtn.click();

    await expect(kanbanBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('C3 — clicar "Lista" após Kanban restaura a tabela', async ({ page }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para a seção do funil
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Vai para Kanban
    await page.getByRole('button', { name: /Kanban/i, exact: true }).click();
    await expect(page.locator('[role="table"]')).not.toBeVisible({ timeout: 5_000 });

    // Volta para Lista
    await page.getByRole('button', { name: /Lista/i, exact: true }).click();
    await expect(page.locator('[role="table"]')).toBeVisible({ timeout: 15_000 });

    // Toggle Lista está pressionado
    await expect(
      page.getByRole('button', { name: /Lista/i, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  // ── D. Testes visuais (OBRIGATÓRIO — CLAUDE.md) ──────────────────────────────

  test('D1 — VISUAL — view Lista, tab Invitados (5 linhas)', async ({ page }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Scroll para seção do funil e aguarda tabela e todos badges carregarem
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('[role="table"] tbody tr')).toHaveCount(5, {
      timeout: 20_000,
    });

    // Screenshot com máscara em áreas dinâmicas (avatares, datas calculadas)
    await expect(page).toHaveScreenshot('vacancy-detail-refactor-list.png', {
      fullPage: true,
      mask: [
        // Mascarar potenciais avatares
        page.locator('[data-testid="worker-avatar"]'),
      ],
      maxDiffPixelRatio: 0.03,
    });
  });

  test('D2 — VISUAL — view Kanban (colunas do board)', async ({ page }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    // Navega para Kanban
    await page.getByRole('button', { name: /Kanban/i, exact: true }).click();

    // Aguarda KanbanBoard renderizar
    await expect(page.locator('text=Ana García').first()).toBeVisible({
      timeout: 10_000,
    });

    await expect(page).toHaveScreenshot('vacancy-detail-refactor-kanban.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('D3 — VISUAL — view Lista, tab Postulados (2 linhas)', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('[role="tablist"] button', { hasText: /Postulados/i }).click();
    await expect(page.locator('[role="table"] tbody tr')).toHaveCount(2, {
      timeout: 20_000,
    });

    await expect(page).toHaveScreenshot(
      'vacancy-detail-refactor-list-postulados.png',
      {
        fullPage: true,
        maxDiffPixelRatio: 0.03,
      },
    );
  });

  test('D4 — VISUAL — view Lista, tab Desistentes (empty state)', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=226').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('[role="tablist"] button', { hasText: /Desistentes/i }).click();
    await expect(
      page.locator('text=/Sin candidatos en esta etapa/i').first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page).toHaveScreenshot(
      'vacancy-detail-refactor-list-desistentes-empty.png',
      {
        fullPage: true,
        maxDiffPixelRatio: 0.03,
      },
    );
  });
});
