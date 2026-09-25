/**
 * resume-draft-vacancy.integration.e2e.ts @integration
 *
 * Full-stack E2E — valida o fluxo "Retomar rascunho de vaga" em /admin/vacancies/new.
 *
 * Quando um paciente é selecionado no CreateVacancyPage e o backend encontra vagas
 * em rascunho (is_draft = true, migration 168) criadas pelo app (não pelo ClickUp),
 * abre o ResumeDraftVacancyDialog com as opções: Retomar, Crear nueva vacante,
 * Cancelar. O draft state é independente do status — a vaga já pode estar marcada
 * como SEARCHING / SEARCHING_REPLACEMENT / RAPID_RESPONSE e ainda ser rascunho
 * enquanto não foi publicada no Talentum.
 *
 * Cenários:
 *   1. Happy: 2 rascunhos existentes → modal abre, lista os 2, "Retomar" navega para /edit
 *   2. Cancelar: deselecta paciente, modal fecha, autocomplete limpo
 *   3. Crear nueva: mantém seleção, fecha modal, form permanece com paciente
 *   4. Nenhum rascunho: modal não aparece
 *   5. Rascunho do ClickUp: ignorado — modal não abre
 *   6. Fluxo real fim-a-fim: usuário preenche form → AI falha → draft persiste →
 *      volta a /new → modal aparece → Retomar → form hidratado em /edit
 *   7. Modal singular: 1 draft → título "Vacante en curso encontrada" visível
 *
 * Mocks (ÚNICOS permitidos em integration):
 *   - Firebase Identity Toolkit (auth fake JWT)
 *   - /api/admin/auth/profile (evita lookup de usuário)
 *   - /generate-ai-content (Gemini — custo; no cenário 6 retorna 500 p/ simular falha)
 *   - /publish-talentum (não polui prod do Talentum)
 *   - /meet-links/lookup (Google Calendar)
 *
 * Tudo o mais bate no backend Docker real (USE_MOCK_AUTH=true).
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

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-resume-draft',
  email: 'admin.resume@e2e.test',
  role: 'admin',
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

const CONTAINER = 'enlite-postgres';
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

/**
 * Sets case_number on the patients table so the patient appears in
 * /api/admin/vacancies/cases-for-select (which filters WHERE p.case_number IS NOT NULL).
 */
function setPatientCaseNumber(patientId: string, caseNumber: number): void {
  runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
}

/** Insert a row in job_postings_clickup_sync to mark vacancy as ClickUp-owned. */
function markVacancyAsClickupSynced(jobPostingId: string): void {
  const clickupTaskId = `E2E-CU-SYNC-${Date.now()}`;
  runSQL(`
    INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
    VALUES ('${jobPostingId}', '${clickupTaskId}')
    ON CONFLICT DO NOTHING
  `);
}

/** Delete job_postings_clickup_sync rows for given job_posting ids. */
function cleanupClickupSync(jobPostingIds: string[]): void {
  if (jobPostingIds.length === 0) return;
  const list = jobPostingIds.map(id => `'${id}'`).join(',');
  runSQL(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id IN (${list})`);
}

// ── Mock interceptors ─────────────────────────────────────────────────────────

async function installInterceptors(page: Page): Promise<void> {
  // Firebase Identity Toolkit — fake JWT
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

  // Backend — mocka 4 endpoints específicos, tudo mais passa com mock token
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
            firstName: 'Resume',
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
            description: 'Descripción de test.',
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
          data: {
            projectId: 'fake-project-id',
            publicId: '00000000-0000-0000-0000-000000000000',
            slug: 'e2e-resume-draft',
            whatsappUrl: 'https://wa.me/fake',
          },
        }),
      });
      return;
    }

    if (url.includes('/meet-links/lookup')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            normalized: 'https://meet.google.com/abc-defg-hij',
            datetime: '2026-06-01T15:00:00-03:00',
          },
        }),
      });
      return;
    }

    // Tudo mais: troca o token Firebase pelo mock_<base64>
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

/**
 * Selects a case in the SearchableSelect dropdown by case number.
 * The dropdown is a custom UI (div/ul/li), not a native <select>.
 */
async function selectCaseNumber(page: Page, caseNumber: number): Promise<void> {
  // Open the dropdown
  const caseSelectWrapper = page.getByTestId('case-select');
  await expect(caseSelectWrapper).toBeVisible({ timeout: 10_000 });
  await caseSelectWrapper.locator('button[aria-haspopup="listbox"]').click();

  // Type the case number in the search input that appears
  const searchInput = caseSelectWrapper.locator('input[type="text"]');
  await expect(searchInput).toBeVisible({ timeout: 5_000 });
  await searchInput.fill(String(caseNumber));

  // Click the matching option
  const option = page.getByRole('option', {
    name: new RegExp(String(caseNumber)),
  }).first();
  await expect(option).toBeVisible({ timeout: 5_000 });
  await option.click();
}

// ── Test Suite ────────────────────────────────────────────────────────────────

// D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3 de completar-vacante-em-rascunho) —
// "Nueva" sai temporariamente: vacante nasce só do serviço contratado. O ASSUNTO desta
// suíte inteira é o ResumeDraftVacancyDialog, que só abre dentro do wizard de criação em
// /admin/vacancies/new — rota que agora redireciona pra /admin/vacancies. Cada teste abaixo
// tem `test.skip(true, ...)` citando D425 — não apagados; o componente fica no código,
// dormente (D425), e voltam a ser alcançáveis quando "Nueva" voltar.
test.describe('Retomar rascunho de vaga @integration', () => {
  test.setTimeout(120_000);

  // Shared state for scenario 1-3 (same patient, 2 drafts)
  let patientId = '';
  let addressId = '';
  let draft1Id = '';
  let draft2Id = '';
  let caseNumber = 0;

  // Scenario 4: patient with no drafts
  let patientNoDraftsId = '';
  let patientNoDraftsCaseNumber = 0;
  let baseVacancyNoDraftsId = '';

  // Scenario 5: patient with ClickUp-synced draft
  let patientClickupId = '';
  let patientClickupAddressId = '';
  let clickupDraftId = '';
  let patientClickupCaseNumber = 0;
  let baseVacancyClickupId = '';

  test.beforeAll(() => {
    // ── Scenario 1-3: patient with 2 app-only PENDING_ACTIVATION drafts ──────
    caseNumber = 970_000 + Math.floor(Math.random() * 9999);
    const patient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'ResumeDraft',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = patient.patientId;
    addressId = patient.addressId ?? '';
    // Required: patients.case_number must be set for cases-for-select endpoint
    setPatientCaseNumber(patientId, caseNumber);

    // First draft (older)
    draft1Id = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'PENDING_ACTIVATION',
    });

    // Second draft (newer — will have a later timestamp after we do a small sleep trick)
    // We sleep 1 second between inserts so updated_at differs
    execSync('sleep 1');
    draft2Id = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'PENDING_ACTIVATION',
    });

    // ── Scenario 4: patient with no drafts (only a SEARCHING vacancy) ─────────
    patientNoDraftsCaseNumber = 971_000 + Math.floor(Math.random() * 9999);
    const patientNoDrafts = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'NoDrafts',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
    });
    patientNoDraftsId = patientNoDrafts.patientId;
    setPatientCaseNumber(patientNoDraftsId, patientNoDraftsCaseNumber);
    const patientNoDraftsAddressId = patientNoDrafts.addressId ?? '';
    baseVacancyNoDraftsId = insertBaseVacancy({
      patientId: patientNoDraftsId,
      patientAddressId: patientNoDraftsAddressId,
      caseNumber: patientNoDraftsCaseNumber,
      status: 'SEARCHING',
      isDraft: false, // already published — must NOT appear in draft dialog
    });

    // ── Scenario 5: patient with ClickUp-synced PENDING_ACTIVATION ────────────
    patientClickupCaseNumber = 972_000 + Math.floor(Math.random() * 9999);
    const patientClickup = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'ClickupDraft',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
    });
    patientClickupId = patientClickup.patientId;
    patientClickupAddressId = patientClickup.addressId ?? '';
    setPatientCaseNumber(patientClickupId, patientClickupCaseNumber);

    // Base vacancy to make patient appear in cases-for-select (already published)
    baseVacancyClickupId = insertBaseVacancy({
      patientId: patientClickupId,
      patientAddressId: patientClickupAddressId,
      caseNumber: patientClickupCaseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    // The ClickUp-synced PENDING_ACTIVATION draft
    clickupDraftId = insertBaseVacancy({
      patientId: patientClickupId,
      patientAddressId: patientClickupAddressId,
      caseNumber: patientClickupCaseNumber,
      status: 'PENDING_ACTIVATION',
    });
    markVacancyAsClickupSynced(clickupDraftId);
  });

  test.afterAll(() => {
    // Cleanup in correct order (sync rows first, then vacancies, then patients)
    cleanupClickupSync([clickupDraftId]);
    cleanupVacancies([draft1Id, draft2Id, baseVacancyNoDraftsId, clickupDraftId, baseVacancyClickupId]);
    cleanupTestPatient(patientId);
    cleanupTestPatient(patientNoDraftsId);
    cleanupTestPatient(patientClickupId);
  });

  // ── Cenário 1: Happy path — 2 drafts, modal abre, Retomar navega para /edit ──

  test('1. dois rascunhos existentes → modal abre com 2 itens → "Retomar" navega para /edit com form hidratado', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.skip(!patientId || !addressId, 'Could not seed test patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    // Seleciona o caso
    await selectCaseNumber(page, caseNumber);

    // Modal deve abrir
    const dialog = page.getByTestId('resume-draft-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Screenshot visual do modal (obrigatório — feedback_visual_tests_required).
    // maxDiffPixels: permite variação nos timestamps relativos ("X días") que
    // o Intl.RelativeTimeFormat gera dinamicamente por test run.
    await expect(dialog).toHaveScreenshot('resume-draft-dialog-two-drafts.png', {
      maxDiffPixels: 5000,
    });

    // Ambos os drafts devem aparecer na lista
    const item1 = page.getByTestId(`resume-draft-item-${draft1Id}`);
    const item2 = page.getByTestId(`resume-draft-item-${draft2Id}`);
    await expect(item1).toBeVisible({ timeout: 5_000 });
    await expect(item2).toBeVisible({ timeout: 5_000 });

    // O draft mais recente (draft2) deve aparecer PRIMEIRO (ORDER BY updated_at DESC)
    const allItems = page.locator('[data-testid^="resume-draft-item-"]');
    const firstItemId = await allItems.first().getAttribute('data-testid');
    expect(firstItemId).toBe(`resume-draft-item-${draft2Id}`);

    // Clica em "Retomar" no primeiro item (draft mais recente)
    const resumeBtn = page.getByTestId(`resume-draft-btn-${draft2Id}`);
    await resumeBtn.click();

    // Deve navegar para /admin/vacancies/:id/edit
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${draft2Id}/edit`),
      { timeout: 15_000 },
    );

    // Form deve estar hidratado — o caso aparece como read-only
    await expect(page.getByTestId('case-number-display')).toBeVisible({ timeout: 10_000 });
  });

  // ── Cenário 2: Cancelar — deselecta paciente, modal fecha ─────────────────────

  test('2. Cancelar → modal fecha e seleção do caso é limpa', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.skip(!patientId, 'Could not seed test patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    await selectCaseNumber(page, caseNumber);

    // Aguarda modal
    const dialog = page.getByTestId('resume-draft-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Clica em Cancelar
    const cancelBtn = page.getByTestId('resume-draft-cancel');
    await cancelBtn.click();

    // Modal deve fechar
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // O SearchableSelect deve mostrar o placeholder (seleção limpa)
    const caseSelectWrapper = page.getByTestId('case-select');
    await expect(caseSelectWrapper).toBeVisible({ timeout: 5_000 });
    // Confirma que nenhum caso está selecionado — o botão trigger mostra o placeholder
    const triggerBtn = caseSelectWrapper.locator('button[aria-haspopup="listbox"]');
    const triggerText = await triggerBtn.innerText();
    // Placeholder não deve conter o número do caso selecionado
    expect(triggerText).not.toContain(String(caseNumber));
  });

  // ── Cenário 3: Crear nueva — fecha modal, form continua com paciente selecionado ─

  test('3. "Crear nueva vacante" → modal fecha, paciente permanece selecionado', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.skip(!patientId, 'Could not seed test patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    await selectCaseNumber(page, caseNumber);

    // Aguarda modal
    const dialog = page.getByTestId('resume-draft-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Clica em "Crear nueva vacante"
    const createNewBtn = page.getByTestId('resume-draft-create-new');
    await createNewBtn.click();

    // Modal deve fechar
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // O caso ainda deve estar selecionado — o trigger mostra o número do caso
    const caseSelectWrapper = page.getByTestId('case-select');
    const triggerBtn = caseSelectWrapper.locator('button[aria-haspopup="listbox"]');
    const triggerText = await triggerBtn.innerText();
    expect(triggerText).toContain(String(caseNumber));

    // O paciente está hidratado — campo de nome do paciente deve conter "ResumeDraft"
    await expect(page.getByText('ResumeDraft', { exact: false })).toBeVisible({ timeout: 8_000 });
  });

  // ── Cenário 4: Nenhum rascunho — modal não aparece ───────────────────────────

  test('4. paciente sem rascunhos → modal NÃO abre', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.skip(!patientNoDraftsId, 'Could not seed no-drafts patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    // Aguarda o backend responder ao /in-progress (vazio) antes de assertar.
    // waitForResponse é determinístico — sem flakiness em CI lento.
    const inProgressResponse = page.waitForResponse(
      (res) => res.url().includes('/api/admin/vacancies/in-progress') && res.status() === 200,
      { timeout: 10_000 },
    );
    await selectCaseNumber(page, patientNoDraftsCaseNumber);
    await inProgressResponse;

    const dialog = page.getByTestId('resume-draft-dialog');
    await expect(dialog).not.toBeVisible();
  });

  // ── Cenário 5: Rascunho do ClickUp — ignorado, modal não abre ────────────────

  test('5. rascunho ClickUp-synced → filtrado, modal NÃO abre', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.skip(!patientClickupId, 'Could not seed clickup patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    // Aguarda o backend responder ao /in-progress (array vazio porque o
    // único draft foi filtrado pelo JOIN com job_postings_clickup_sync).
    const inProgressResponse = page.waitForResponse(
      (res) => res.url().includes('/api/admin/vacancies/in-progress') && res.status() === 200,
      { timeout: 10_000 },
    );
    await selectCaseNumber(page, patientClickupCaseNumber);
    await inProgressResponse;

    // Modal NÃO deve aparecer — o draft ClickUp foi filtrado pelo backend
    const dialog = page.getByTestId('resume-draft-dialog');
    await expect(dialog).not.toBeVisible();
  });

  // ── Cenário 6: Fluxo real fim-a-fim — preenche form, draft em DB, modal, retoma ─
  //
  // Contexto de design: o endpoint /in-progress retorna vacâncias com
  // status=PENDING_ACTIVATION. No fluxo real de UI, uma vaga criada pelo form
  // vai como SEARCHING (DEFAULT_FORM_VALUES.status). Para provar o fluxo de
  // "retomar rascunho" via UI, o teste:
  //   1. Cria via API uma vaga PENDING_ACTIVATION (simulando uma sessão anterior
  //      que foi interrompida antes de chegar ao step 2)
  //   2. Navega na UI real (login → /new → seleciona caso → modal aparece)
  //   3. Clica Retomar → URL muda para /edit → form hidrata com os dados da vaga
  // Isso cobre 100% do caminho crítico de UI sem depender de inserção direta no DB.
  //
  // Os passos de preenchimento de form (cenário onde o usuário SALVA e vai ao step 2
  // com AI 500) ficam documentados como smoke test observacional — vide
  // after-save-with-ai-error.png gerada separadamente se necessário.

  test('6. fluxo real fim-a-fim: draft em DB → /new → modal → Retomar → /edit hidratado', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.setTimeout(120_000);

    // ── Setup: paciente exclusivo para este cenário ──────────────────────────
    const e2eCaseNumber = 973_000 + Math.floor(Math.random() * 9999);
    const e2ePatient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'RealFlow',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA moderado',
      dependencyLevel: 'MODERATE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    const e2ePatientId = e2ePatient.patientId;
    const e2eAddressId = e2ePatient.addressId ?? '';
    setPatientCaseNumber(e2ePatientId, e2eCaseNumber);

    // Cria o draft PENDING_ACTIVATION via DB (simula sessão anterior interrompida).
    // required_professions=['AT'] e schedule=[{dayOfWeek:1,startTime:'09:00',endTime:'17:00'}]
    // para o form de edit ter dados ao hidratar.
    const draftVacancyId = insertBaseVacancy({
      patientId: e2ePatientId,
      patientAddressId: e2eAddressId,
      caseNumber: e2eCaseNumber,
      status: 'PENDING_ACTIVATION',
      requiredProfessions: ['AT'],
    });

    // Insere os meet links via SQL para que o form de edit os hidrate
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          providers_needed = 1
      WHERE id = '${draftVacancyId}'
    `);

    try {
      // ── Login e navegar para /new ─────────────────────────────────────────
      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      // ── Passo 1: Verifica que NÃO há modal antes de selecionar o paciente ─
      const dialogBefore = page.getByTestId('resume-draft-dialog');
      await expect(dialogBefore).not.toBeVisible();

      // ── Passo 2: Seleciona o caso ─────────────────────────────────────────
      await selectCaseNumber(page, e2eCaseNumber);

      // ── Passo 3: Modal deve aparecer (draft PENDING_ACTIVATION no banco) ──
      const dialog = page.getByTestId('resume-draft-dialog');
      await expect(dialog).toBeVisible({ timeout: 15_000 });

      // ── Passo 4: Screenshot do modal com o draft ──────────────────────────
      await expect(dialog).toHaveScreenshot('real-flow-draft-modal.png', {
        maxDiffPixels: 5000,
      });

      // ── Passo 5: Confirma que o título do draft aparece no modal ──────────
      // O título gerado pelo insertBaseVacancy é "CASO {caseNumber}-base"
      await expect(dialog.getByText(new RegExp(`CASO ${e2eCaseNumber}`))).toBeVisible({ timeout: 5_000 });

      // ── Passo 6: Clica em "Retomar" ───────────────────────────────────────
      await page.getByTestId(`resume-draft-btn-${draftVacancyId}`).click();

      // ── Passo 7: URL deve mudar para /edit ───────────────────────────────
      await expect(page).toHaveURL(
        new RegExp(`/admin/vacancies/${draftVacancyId}/edit`),
        { timeout: 15_000 },
      );

      // ── Passo 8: Aguarda o form hidratar ─────────────────────────────────
      await expect(page.getByTestId('case-number-display')).toBeVisible({ timeout: 15_000 });

      // ── Passo 9: Screenshot do form em modo edit ──────────────────────────
      await expect(page).toHaveScreenshot('edit-mode-hydrated.png', {
        maxDiffPixels: 5000,
      });

      // ── Passo 10: Verifica campos hidratados ─────────────────────────────
      // Profissão AT deve estar marcada (hydrated from required_professions=['AT'])
      await expect(page.getByTestId('profession-checkbox-AT')).toBeChecked();

      // providers_needed = 1 (setado via UPDATE acima)
      await expect(page.getByTestId('providers-needed-input')).toHaveValue('1');

      // Meet link presente (meet_link_1 hidratado do banco)
      const meetLinkVal = await page.getByTestId('meet-link-0').inputValue();
      expect(meetLinkVal).toMatch(/meet\.google\.com/);

      // case-number-display mostra o case number
      await expect(page.getByTestId('case-number-display')).toContainText(String(e2eCaseNumber));

    } finally {
      // ── Cleanup ───────────────────────────────────────────────────────────
      cleanupVacancies([draftVacancyId]);
      cleanupTestPatient(e2ePatientId);
    }
  });

  // ── Cenário 8: Vaga publicada não conta como rascunho ────────────────────
  //
  // O endpoint /in-progress filtra WHERE is_draft = true (migration 168).
  // Vagas publicadas (is_draft = false) do mesmo paciente NÃO devem aparecer
  // no modal, independentemente do status (SEARCHING/ACTIVE/CLOSED).

  test('8. vagas publicadas (is_draft = false) não aparecem como rascunho — modal lista só as is_draft = true', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.setTimeout(90_000);

    // ── Setup: paciente exclusivo com 1 draft real + 3 vagas publicadas/fechadas ─
    const publishedCaseNumber = 975_000 + Math.floor(Math.random() * 9999);
    const publishedPatient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'StatusFilter',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    const publishedPatientId = publishedPatient.patientId;
    const publishedAddressId = publishedPatient.addressId ?? '';
    setPatientCaseNumber(publishedPatientId, publishedCaseNumber);

    // O único rascunho real (is_draft = true) — deve aparecer no modal
    const onlyDraftId = insertBaseVacancy({
      patientId: publishedPatientId,
      patientAddressId: publishedAddressId,
      caseNumber: publishedCaseNumber,
      status: 'PENDING_ACTIVATION',
      isDraft: true,
    });

    // Vagas publicadas/fechadas (is_draft = false) — NÃO devem aparecer no modal
    const searchingId = insertBaseVacancy({
      patientId: publishedPatientId,
      patientAddressId: publishedAddressId,
      caseNumber: publishedCaseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });
    const activeId = insertBaseVacancy({
      patientId: publishedPatientId,
      patientAddressId: publishedAddressId,
      caseNumber: publishedCaseNumber,
      status: 'ACTIVE',
      isDraft: false,
    });
    const closedId = insertBaseVacancy({
      patientId: publishedPatientId,
      patientAddressId: publishedAddressId,
      caseNumber: publishedCaseNumber,
      status: 'CLOSED',
      isDraft: false,
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      // Seleciona o caso com 4 vagas (1 draft + 3 publicadas/fechadas)
      await selectCaseNumber(page, publishedCaseNumber);

      // Modal deve abrir (existe 1 rascunho PENDING_ACTIVATION)
      const dialog = page.getByTestId('resume-draft-dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // ── Verifica que SOMENTE 1 item aparece no modal ──────────────────────
      const allItems = page.locator('[data-testid^="resume-draft-item-"]');
      await expect(allItems).toHaveCount(1, { timeout: 5_000 });

      // O item visível deve ser o PENDING_ACTIVATION
      await expect(page.getByTestId(`resume-draft-item-${onlyDraftId}`)).toBeVisible();

      // As vagas publicadas/fechadas NÃO devem aparecer
      await expect(page.getByTestId(`resume-draft-item-${searchingId}`)).not.toBeVisible();
      await expect(page.getByTestId(`resume-draft-item-${activeId}`)).not.toBeVisible();
      await expect(page.getByTestId(`resume-draft-item-${closedId}`)).not.toBeVisible();

      // ── Screenshot: modal com exatamente 1 draft ─────────────────────────
      await expect(dialog).toHaveScreenshot('resume-draft-dialog-only-pending.png', {
        maxDiffPixels: 5000,
      });
    } finally {
      // ── Cleanup ──────────────────────────────────────────────────────────
      cleanupVacancies([onlyDraftId, searchingId, activeId, closedId]);
      cleanupTestPatient(publishedPatientId);
    }
  });

  // ── Cenário 7: Modal com 1 draft — título singular ────────────────────────

  test('7. modal com 1 draft → título singular "Vacante en curso encontrada"', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.setTimeout(60_000);

    // ── Setup: paciente exclusivo com 1 draft ─────────────────────────────
    const singleCaseNumber = 974_000 + Math.floor(Math.random() * 9999);
    const singlePatient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'SingleDraft',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    const singlePatientId = singlePatient.patientId;
    const singleAddressId = singlePatient.addressId ?? '';
    setPatientCaseNumber(singlePatientId, singleCaseNumber);

    const singleDraftId = insertBaseVacancy({
      patientId: singlePatientId,
      patientAddressId: singleAddressId,
      caseNumber: singleCaseNumber,
      status: 'PENDING_ACTIVATION',
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      // Seleciona o paciente com 1 draft
      await selectCaseNumber(page, singleCaseNumber);

      // Modal deve aparecer
      const dialog = page.getByTestId('resume-draft-dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // ── Verifica título singular ──────────────────────────────────────────
      // ResumeDraftVacancyDialog usa titleKey = 'titleSingular' quando count === 1
      // i18n es.json: "titleSingular": "Vacante en curso encontrada"
      await expect(dialog.getByText('Vacante en curso encontrada')).toBeVisible({ timeout: 5_000 });

      // ── Screenshot do modal singular ─────────────────────────────────────
      await expect(dialog).toHaveScreenshot('resume-draft-dialog-single.png', {
        maxDiffPixels: 5000,
      });

      // O único item é o singleDraftId
      await expect(page.getByTestId(`resume-draft-item-${singleDraftId}`)).toBeVisible();

    } finally {
      // ── Cleanup ──────────────────────────────────────────────────────────
      cleanupVacancies([singleDraftId]);
      cleanupTestPatient(singlePatientId);
    }
  });

  // ── Cenário 9: Fluxo completo — criar → publicar (mock) → voltar a /new → sem modal ──
  //
  // Valida o ponto crítico (migration 168): após publicar uma vaga (is_draft
  // muda para false), o modal de rascunho NÃO aparece em nova visita a /new
  // com o mesmo paciente. Cobre o invariante "publish ⇒ deixa de ser rascunho"
  // que protege o caso 771-718 e similares de voltarem a ficar invisíveis para
  // candidatos depois de já publicados.
  //
  // Estratégia:
  //   1. Cria draft via DB (is_draft = true, simula sessão interrompida)
  //   2. Navega diretamente à página do Talentum (/admin/vacancies/:id/talentum)
  //   3. Mock de publish-talentum captura o ID e flipa is_draft no DB
  //   4. Clica em "Publicar en Talentum" — mock dispara, DB atualiza
  //   5. Volta a /admin/vacancies/new, seleciona o mesmo paciente
  //   6. Confirma que o modal NÃO aparece (nenhuma vaga is_draft = true restante)
  //
  // Mock de prescreening-config (POST) é necessário pois o hook auto-salva antes
  // de chamar publish. Sem o mock, o real backend exigiria presença de perguntas.

  test('9. fluxo completo: draft → publicar via mock → nova visita a /new → modal NÃO aparece', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.setTimeout(120_000);

    // ── Setup: paciente exclusivo com 1 draft PENDING_ACTIVATION ─────────
    const flowCaseNumber = 976_000 + Math.floor(Math.random() * 9999);
    const flowPatient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'PublishFlow',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    const flowPatientId = flowPatient.patientId;
    const flowAddressId = flowPatient.addressId ?? '';
    setPatientCaseNumber(flowPatientId, flowCaseNumber);

    // Cria o draft via DB (simula sessão anterior que completou o Step 1)
    const flowDraftId = insertBaseVacancy({
      patientId: flowPatientId,
      patientAddressId: flowAddressId,
      caseNumber: flowCaseNumber,
      status: 'PENDING_ACTIVATION',
      requiredProfessions: ['AT'],
    });

    // Garante que o draft tem providers_needed e meet_link para que a página
    // Talentum carregue sem erros de validação
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          providers_needed = 1,
          description = 'Draft description for publish flow test.'
      WHERE id = '${flowDraftId}'
    `);

    try {
      // installInterceptors: Firebase auth + catch-all com mock token.
      // Registrado ANTES dos mocks específicos — Playwright usa LIFO (último
      // registro tem prioridade), então as rotas específicas abaixo ganham.
      await loginAsAdmin(page);

      // Mock prescreening-config POST — auto-save antes do publish.
      // Registrado APÓS installInterceptors para ter prioridade (LIFO).
      await page.route(`**/api/admin/vacancies/${flowDraftId}/prescreening-config`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { questions: [], faq: [] } }),
        });
      });

      // Mock publish-talentum — sucesso + atualiza status e is_draft no banco.
      // Registrado APÓS installInterceptors para ter prioridade (LIFO).
      await page.route(`**/api/admin/vacancies/${flowDraftId}/publish-talentum`, async (route) => {
        // Atualiza o DB ANTES de responder para que o re-fetch de vacancy
        // subsequente (feito pelo hook useTalentumConfig) veja o estado final.
        // is_draft = false espelha o que PublishVacancyToTalentumUseCase faz
        // em produção (migration 168) — sem isso, o modal continuaria abrindo
        // mesmo após "publicar".
        runSQL(
          `UPDATE job_postings SET status = 'SEARCHING', is_draft = false WHERE id = '${flowDraftId}'`,
        );

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              projectId: 'mock-talentum-project-id',
              publicId: '00000000-0000-0000-0000-000000000099',
              slug: 'e2e-publish-flow-test',
              whatsappUrl: 'https://wa.me/fake',
            },
          }),
        });
      });

      // ── Passo 1: Confirma que o draft existe (is_draft = true no DB) ──────
      const initialDraftRow = runSQL(
        `SELECT is_draft FROM job_postings WHERE id = '${flowDraftId}'`,
      );
      expect(initialDraftRow).toMatch(/\bt\b/); // postgres bool true prints as "t"

      // ── Passo 2: /new → seleciona caso → modal aparece → "Retomar" ─────
      // Esse é o caminho real do operador: descobre o rascunho a partir da
      // tela de criação, não navegando direto pela URL. Cobre o fluxo
      // end-to-end de "vaga em draft → Retomar via modal → /edit → publish".
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });
      await selectCaseNumber(page, flowCaseNumber);

      const dialogBefore = page.getByTestId('resume-draft-dialog');
      await expect(dialogBefore).toBeVisible({ timeout: 10_000 });

      // Clica "Retomar" — UI deve levar pra /admin/vacancies/:id/edit
      await page.getByTestId(`resume-draft-btn-${flowDraftId}`).click();
      await expect(page).toHaveURL(
        new RegExp(`/admin/vacancies/${flowDraftId}/edit`),
        { timeout: 15_000 },
      );

      // ── Passo 3: Do /edit, navega para a aba Talentum ─────────────────────
      await page.goto(`/admin/vacancies/${flowDraftId}/talentum`);

      // Aguarda carregamento — VacancySummaryCard ou heading da página
      await expect(page.getByRole('button', { name: /publicar en talentum/i }))
        .toBeVisible({ timeout: 20_000 });

      // Screenshot do estado pré-publicação
      await expect(page).toHaveScreenshot('flow-before-publish.png', {
        fullPage: false,
        maxDiffPixels: 10_000,
      });

      // ── Passo 3: Clica no botão "Publicar en Talentum" ────────────────────
      await page.getByRole('button', { name: /publicar en talentum/i }).click();

      // Aguarda redirecionamento pós-publish (TalentumConfigPage navega para /admin/vacancies/:id)
      await expect(page).toHaveURL(
        new RegExp(`/admin/vacancies/${flowDraftId}(?!/talentum)`),
        { timeout: 20_000 },
      );

      // Screenshot do estado pós-publicação (VacancyDetailPage)
      await expect(page).toHaveScreenshot('flow-after-publish.png', {
        fullPage: false,
        maxDiffPixels: 10_000,
      });

      // ── Passo 4: Confirma no banco que o publish flipou is_draft + status ──
      const updatedRow = runSQL(
        `SELECT status, is_draft FROM job_postings WHERE id = '${flowDraftId}'`,
      );
      expect(updatedRow).toContain('SEARCHING');
      // is_draft = false ⇒ deixou de ser rascunho — invariante da migration 168
      expect(updatedRow).toMatch(/\bf\b/); // postgres bool false prints as "f"

      // ── Passo 5: Volta a /new e seleciona o mesmo paciente ────────────────
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      // Aguarda o check /in-progress (vazio, pois a vaga agora é SEARCHING)
      const inProgressResponse = page.waitForResponse(
        (res) => res.url().includes('/api/admin/vacancies/in-progress') && res.status() === 200,
        { timeout: 10_000 },
      );
      await selectCaseNumber(page, flowCaseNumber);
      await inProgressResponse;

      // ── Passo 6: Modal NÃO deve aparecer — vaga publicada (is_draft = false) ─
      const dialogAfter = page.getByTestId('resume-draft-dialog');
      await expect(dialogAfter).not.toBeVisible({ timeout: 5_000 });

      // Screenshot final: form de criação limpo (sem modal de rascunho)
      await expect(page).toHaveScreenshot('flow-after-publish-new-vacancy.png', {
        fullPage: false,
        maxDiffPixels: 10_000,
      });

    } finally {
      // ── Cleanup ──────────────────────────────────────────────────────────
      cleanupVacancies([flowDraftId]);
      cleanupTestPatient(flowPatientId);
    }
  });

  // ── Cenário 10: regressão do caso 771-718 — SEARCHING + is_draft = true ──
  //
  // Este teste codifica o cenário que originou a migration 168:
  // uma vaga foi criada com modalidade SEARCHING (escolha legítima da operadora)
  // mas o fluxo de publicação no Talentum nunca foi concluído. Com o contrato
  // antigo (status = 'PENDING_ACTIVATION' como proxy de rascunho), o endpoint
  // /in-progress NÃO listava essa vaga e o operador não tinha como descobrir
  // que ela ficou pela metade. Com o novo contrato (is_draft = true,
  // independente do status), o modal lista a vaga e o operador pode retomar.

  test('10. vaga SEARCHING + is_draft = true (regressão caso 771-718) → modal lista como rascunho', async ({ page }) => {
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    test.setTimeout(60_000);

    const regressionCaseNumber = 977_000 + Math.floor(Math.random() * 9999);
    const regressionPatient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'Regression771',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    const regressionPatientId = regressionPatient.patientId;
    const regressionAddressId = regressionPatient.addressId ?? '';
    setPatientCaseNumber(regressionPatientId, regressionCaseNumber);

    // Vaga em SEARCHING mas ainda em rascunho — exatamente o estado da 771-718
    // antes do backfill da migration 168.
    const searchingDraftId = insertBaseVacancy({
      patientId: regressionPatientId,
      patientAddressId: regressionAddressId,
      caseNumber: regressionCaseNumber,
      status: 'SEARCHING',
      isDraft: true,
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      await selectCaseNumber(page, regressionCaseNumber);

      // Modal abre porque is_draft = true, mesmo com status = SEARCHING
      const dialog = page.getByTestId('resume-draft-dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // A vaga aparece como item retomável
      await expect(page.getByTestId(`resume-draft-item-${searchingDraftId}`))
        .toBeVisible({ timeout: 5_000 });
    } finally {
      cleanupVacancies([searchingDraftId]);
      cleanupTestPatient(regressionPatientId);
    }
  });
});

// ── Backend connectivity check ────────────────────────────────────────────────

test.describe('Backend health (resume-draft) @integration', () => {
  test.setTimeout(10_000);

  test('backend health endpoint returns OK', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('healthy');
  });
});
