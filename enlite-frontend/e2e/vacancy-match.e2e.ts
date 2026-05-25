/**
 * vacancy-match.e2e.ts
 *
 * Playwright E2E — Tela de Match (/admin/vacancies/:id/match)
 *
 * Fluxo coberto:
 *   - Página carrega com estado vazio quando não há matches salvos
 *   - Botão "Correr match" dispara POST /match e lista aparece
 *   - Score bar reflete finalScore do candidato
 *   - LLM reasoning expande/colapsa ao clicar na linha
 *   - Checkbox seleciona linha; barra de rodapé aparece
 *   - "Selecionar todos" seleciona apenas workers visíveis
 *   - Filtro de score filtra a lista sem re-fetch
 *   - "Enviar WhatsApp" individual abre modal de progresso (sem dropdown de template)
 *   - Modal chama POST /vacancy-match e exibe status "enviado"
 *   - Badge "Notificado" aparece após envio bem-sucedido
 *   - Re-envio em lote: modal avisa workers já notificados com opções de re-envio
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

// ── Fixtures ──────────────────────────────────────────────────────────────

const VACANCY_ID = 'bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 22001,
  title: 'Caso 22001 — Match E2E',
  status: 'BUSQUEDA',
  patient_zone: 'Palermo',
  required_professions: ['AT'],
};

const MOCK_CANDIDATES = [
  {
    workerId:        'worker-aaa-0001',
    workerName:      'Maria Sánchez',
    workerPhone:     '+5491100000001',
    occupation:      'Acompañante Terapéutico',
    workZone:        'Palermo',
    distanceKm:      2.1,
    activeCasesCount: 0,
    overallStatus:   'QUALIFICADO',
    matchScore:      87,
    internalNotes:   'Perfil compatível com TEA. Boa experiência em adultos mayores.',
    alreadyApplied:  false,
    messagedAt:      null,
  },
  {
    workerId:        'worker-bbb-0002',
    workerName:      'Ana Rodríguez',
    workerPhone:     '+5491100000002',
    occupation:      'Enfermera',
    workZone:        'Caballito',
    distanceKm:      4.3,
    activeCasesCount: 1,
    overallStatus:   'PRE-TALENTUM',
    matchScore:      74,
    internalNotes:   null,
    alreadyApplied:  false,
    messagedAt:      null,
  },
  {
    workerId:        'worker-ccc-0003',
    workerName:      'João Pereira',
    workerPhone:     '',
    occupation:      'AT',
    workZone:        'Belgrano',
    distanceKm:      6.0,
    activeCasesCount: 0,
    overallStatus:   'QUALIFICADO',
    matchScore:      55,
    internalNotes:   null,
    alreadyApplied:  false,
    messagedAt:      null,
  },
];

const EMPTY_MATCH_RESULTS = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    lastMatchAt:  null,
    totalCandidates: 0,
    candidates: [],
  },
};

const POPULATED_MATCH_RESULTS = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    lastMatchAt:  '2026-03-26T12:00:00Z',
    totalCandidates: 3,
    candidates: MOCK_CANDIDATES,
  },
};

const MOCK_MATCH_RESPONSE = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    jobEnriched: true,
    radiusKm: null,
    matchSummary: { hardFilteredCount: 5, llmScoredCount: 3 },
    candidates: MOCK_CANDIDATES.map(c => ({
      ...c,
      structuredScore: Math.round(c.matchScore * 0.35),
      llmScore: Math.round(c.matchScore * 1.0),
      finalScore: c.matchScore,
      llmReasoning: c.internalNotes,
      llmRedFlags: [],
      llmStrengths: [],
      registrationWarning: null,
    })),
  },
};

/** Resposta do novo endpoint POST /vacancy-match */
const VACANCY_MATCH_INVITE_SUCCESS = {
  success: true,
  data: {
    templateSlug: 'ar_vacancy_match_complete',
    externalId: 'SM123',
    status: 'queued',
    to: '+5491100000001',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<{ token: string }> {
  const email    = `e2e.match.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid, idToken: token } = (await signUpRes.json()) as {
    localId: string;
    idToken: string;
  };

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at) VALUES ('${uid}', '${email}', 'Admin E2E Match', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at) VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();
  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* ignora */ }

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid, email, role: 'superadmin',
          firstName: 'Admin', lastName: 'E2E',
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

  return { token };
}

async function setupMatchPageMocks(page: Page, matchResults = EMPTY_MATCH_RESULTS) {
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(matchResults) }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────

test.describe('VacancyMatchPage', () => {
  test.setTimeout(60000);

  // ── Estado vazio ──────────────────────────────────────────────────────

  test('página carrega com estado vazio quando não há matches salvos', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);

    await expect(page.locator('text=/Sin match guardado/i').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Correr match/i }).first()).toBeVisible();
  });

  // ── Rodar Match ───────────────────────────────────────────────────────

  test('botão "Correr match" dispara POST /match e lista aparece', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, EMPTY_MATCH_RESULTS);

    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match`, route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MATCH_RESPONSE) });
      }
      return route.continue();
    });

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.getByRole('button', { name: /^Correr match$/i }).first()).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^Correr match$/i }).first().click();

    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Ana Rodríguez').first()).toBeVisible();
  });

  // ── Tabela de candidatos ──────────────────────────────────────────────

  test('score bar aparece para cada candidato', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    await expect(page.locator('text=87').first()).toBeVisible();
  });

  test('LLM reasoning expande ao clicar no chevron', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    await expect(page.locator('text=/Perfil compatível com TEA/i')).not.toBeVisible();

    const mariaRow = page.locator('tr', { hasText: 'Maria Sánchez' }).first();
    await mariaRow.getByRole('button').last().click();

    await expect(page.locator('text=/Perfil compatível com TEA/i')).toBeVisible({ timeout: 5000 });

    await mariaRow.getByRole('button').last().click();
    await expect(page.locator('text=/Perfil compatível com TEA/i')).not.toBeVisible();
  });

  // ── Seleção e rodapé ──────────────────────────────────────────────────

  test('checkbox seleciona linha e barra de rodapé aparece', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    await expect(page.locator('text=/selecionado/i').last()).not.toBeVisible();

    const mariaRow = page.locator('tr', { hasText: 'Maria Sánchez' }).first();
    await mariaRow.locator('input[type="checkbox"]').check();

    await expect(page.locator('text=/1 worker selecionado/i').first()).toBeVisible({ timeout: 5000 });
  });

  test('"Selecionar todos" seleciona apenas workers visíveis', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    await page.locator('thead input[type="checkbox"]').check();

    await expect(page.locator('text=/3 workers selecionados/i').first()).toBeVisible({ timeout: 5000 });

    await page.locator('thead input[type="checkbox"]').uncheck();
    await expect(page.locator('text=/selecionado/i').last()).not.toBeVisible();
  });

  // ── Filtro de score ───────────────────────────────────────────────────

  test('filtro de score filtra a lista sem re-fetch', async ({ page }) => {
    await seedAdminAndLogin(page);

    let matchResultsCallCount = 0;
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route => {
      matchResultsCallCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POPULATED_MATCH_RESULTS) });
    });
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    const callsBefore = matchResultsCallCount;

    const scoreInput = page.locator('input[type="number"]').first();
    await scoreInput.fill('80');

    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Ana Rodríguez')).not.toBeVisible();
    await expect(page.locator('text=João Pereira')).not.toBeVisible();

    expect(matchResultsCallCount).toBe(callsBefore);
  });

  // ── Modal de convite (InviteProgressModal) ────────────────────────────

  test('"Enviar WhatsApp" individual abre modal de progresso sem dropdown de template', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    // Mock do novo endpoint — responde antes de o modal montar
    await page.route('**/api/admin/messaging/whatsapp/vacancy-match', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACANCY_MATCH_INVITE_SUCCESS) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    const mariaRow = page.locator('tr', { hasText: 'Maria Sánchez' }).first();
    await mariaRow.getByTitle('Enviar WhatsApp').click();

    // Modal abre — título sem dropdown de template
    await expect(page.locator('text=/Enviar invitación/i').first()).toBeVisible({ timeout: 5000 });

    // Não deve ter combobox/select de template
    await expect(page.locator('select')).not.toBeVisible();

    // Screenshot do modal de progresso (validação visual obrigatória)
    await expect(page.locator('.fixed').filter({ hasText: /Enviar invitación/i })).toHaveScreenshot('invite-progress-modal-open.png');
  });

  test('modal chama POST /vacancy-match e exibe status "enviado"', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.route('**/api/admin/messaging/whatsapp/vacancy-match', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACANCY_MATCH_INVITE_SUCCESS) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    const mariaRow = page.locator('tr', { hasText: 'Maria Sánchez' }).first();
    await mariaRow.getByTitle('Enviar WhatsApp').click();

    // Status "✓ enviado" deve aparecer (disparo automático — sem dropdown)
    await expect(page.locator('text=/✓ enviado/i').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=/Completado/i').first()).toBeVisible({ timeout: 5000 });

    // Screenshot do modal com status de conclusão
    await expect(page.locator('.fixed').filter({ hasText: /Completado/i })).toHaveScreenshot('invite-progress-modal-done.png');
  });

  test('badge "Notificado" aparece após envio bem-sucedido', async ({ page }) => {
    await seedAdminAndLogin(page);
    await setupMatchPageMocks(page, POPULATED_MATCH_RESULTS);

    await page.route('**/api/admin/messaging/whatsapp/vacancy-match', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACANCY_MATCH_INVITE_SUCCESS) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    const mariaRow = page.locator('tr', { hasText: 'Maria Sánchez' }).first();
    await mariaRow.getByTitle('Enviar WhatsApp').click();
    await expect(page.locator('text=/Completado/i').first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /Cerrar/i }).last().click();

    // Badge "Notificado" deve aparecer na linha de Maria
    await expect(page.locator('text=/Notificado/i').first()).toBeVisible({ timeout: 5000 });
  });

  test('re-envio em lote: modal avisa workers já notificados com opções', async ({ page }) => {
    await seedAdminAndLogin(page);

    const resultsWithNotified = {
      ...POPULATED_MATCH_RESULTS,
      data: {
        ...POPULATED_MATCH_RESULTS.data,
        candidates: [
          { ...MOCK_CANDIDATES[0], messagedAt: '2026-03-25T10:00:00Z' }, // já notificado
          MOCK_CANDIDATES[1],
        ],
      },
    };

    await setupMatchPageMocks(page, resultsWithNotified);
    await page.route('**/api/admin/messaging/whatsapp/vacancy-match', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACANCY_MATCH_INVITE_SUCCESS) }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.locator('text=Maria Sánchez').first()).toBeVisible({ timeout: 15000 });

    // Seleciona ambos
    await page.locator('thead input[type="checkbox"]').check();

    // Clica "Enviar" no rodapé
    const footer = page.locator('[class*="fixed"]').filter({ hasText: /selecionado/i });
    await footer.getByRole('button', { name: /Enviar/i }).click();

    // Modal deve mostrar aviso sobre re-notificação
    await expect(page.locator('text=/ya recibió este mensaje/i').first()).toBeVisible({ timeout: 10000 });

    // Deve ter botões de escolha
    await expect(page.getByRole('button', { name: /Sólo nuevos/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reenviar a todos/i })).toBeVisible();

    // Screenshot do modal de confirmação de re-envio
    await expect(page.locator('.fixed').filter({ hasText: /ya recibió este mensaje/i })).toHaveScreenshot('invite-progress-modal-renotify.png');
  });
});
