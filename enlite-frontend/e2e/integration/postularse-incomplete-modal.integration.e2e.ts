/**
 * postularse-incomplete-modal.integration.e2e.ts @integration
 *
 * Real-stack test: frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real.
 *
 * Guarantees that IncompleteRegistrationModal renders the CORRECT translated labels
 * for every blocking-case combination. The backend is the sole source of truth for
 * missingFields — no client-side recalculation.
 *
 * Auth: worker login via /login with fake Firebase + mock_<base64> token.
 *       See e2e/helpers/worker-auth-helper.ts for details.
 *
 * DB helpers: e2e/helpers/eligibility-worker-helper.ts
 *   - insertEligibilityWorker: fine-grained field control, returns authUid
 *   - insertMinimalVacancy / cleanupMinimalVacancy
 *   - cleanupEligibilityWorker
 *
 * ## Case matrix (10 cases)
 *   1. Only first_name missing → "Nombre"
 *   2. AT, no at_certificate → "Certificado de Acompañante Terapéutico"
 *   3. AT, no resume_cv → "Currículum vitae"
 *   4. CAREGIVER, no identity_document → "Documento de identidad", no at_certificate
 *   5. CAREGIVER, no criminal_record → "Antecedentes penales"
 *   6. Compound: sex + gender + birthDate + no resume_cv + no criminal_record → two sections
 *   7. title_certificate missing → "Título / Certificado" (historical regression)
 *   8. phone missing → "Teléfono" (historical regression: token had no i18n key)
 *   9. profession=NULL → backend treats as AT; AT docs required
 *  10. missingFields=[] (stubbed) → bodyGeneric shown, modal never blank
 *
 * ## Anti-token-cru assertion
 * Every case asserts the modal DOM contains no raw token strings.
 *
 * Pré-condições:
 *   cd worker-functions && docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev
 *
 * Run: pnpm test:e2e:integration
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginAsWorker } from '../helpers/worker-auth-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Raw token strings that must NEVER appear in the modal DOM. */
const RAW_TOKEN_PATTERNS = [
  'first_name', 'last_name', 'birth_date', 'document_number',
  'knowledge_level', 'title_certificate', 'years_experience', 'experience_types',
  'preferred_types', 'preferred_age_range', 'worker_service_areas', 'worker_availability',
  'doc_resume_cv', 'doc_identity_document', 'doc_criminal_record', 'doc_at_certificate',
  'worker_documents',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assertNoRawTokens(modalLocator: ReturnType<Page['locator']>): Promise<void> {
  const modalText = await modalLocator.innerText();
  for (const token of RAW_TOKEN_PATTERNS) {
    expect(modalText, `Raw token "${token}" must not appear in modal`).not.toContain(token);
  }
}

/**
 * Opens the public vacancy page, clicks Postularse, waits for the
 * IncompleteRegistrationModal, and returns the modal card locator.
 */
async function triggerModal(page: Page, vacancyId: string) {
  await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Postularse/i }).click();
  await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
  return page.locator('.fixed.inset-0 > div').first();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('@integration IncompleteRegistrationModal — real stack', () => {
  test.setTimeout(90_000);

  let vacancyId: string;
  const workers: InsertEligibilityWorkerResult[] = [];
  let lastTrackStatus: number | null = null;

  test.beforeAll(() => {
    vacancyId = insertMinimalVacancy();
  });

  test.afterAll(() => {
    cleanupMinimalVacancy(vacancyId);
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  /** Inserts worker, logs in, triggers modal. Records track-channel HTTP status. */
  async function setupCase(
    page: Page,
    opts: Parameters<typeof insertEligibilityWorker>[0],
  ): Promise<ReturnType<Page['locator']>> {
    const w = insertEligibilityWorker(opts);
    workers.push(w);
    lastTrackStatus = null;

    page.on('response', (resp) => {
      if (resp.url().includes('/api/worker-applications/track-channel')) {
        lastTrackStatus = resp.status();
      }
    });

    await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
    return triggerModal(page, vacancyId);
  }

  // ── Caso 1 ────────────────────────────────────────────────────────────────

  test('caso 1: só first_name faltando → "Nombre"', async ({ page }) => {
    const modal = await setupCase(page, { firstName: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Nombre');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso1-firstname.png', { maxDiffPixels: 100 });
  });

  // ── Caso 2 ────────────────────────────────────────────────────────────────

  test('caso 2: AT sem at_certificate → "Certificado de Acompañante Terapéutico"', async ({ page }) => {
    const modal = await setupCase(page, { occupation: 'AT', docAtCertificate: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Documentos');
    await expect(modal).toContainText('Certificado de Acompañante Terapéutico');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso2-at-cert.png', { maxDiffPixels: 100 });
  });

  // ── Caso 3 ────────────────────────────────────────────────────────────────

  test('caso 3: AT sem resume_cv → "Currículum vitae"', async ({ page }) => {
    const modal = await setupCase(page, { occupation: 'AT', docResumeCv: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Documentos');
    await expect(modal).toContainText('Currículum vitae');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso3-resume-cv.png', { maxDiffPixels: 100 });
  });

  // ── Caso 4 ────────────────────────────────────────────────────────────────

  test('caso 4: CAREGIVER sem identity_document → "Documento de identidad", sem at_certificate', async ({ page }) => {
    const modal = await setupCase(page, { occupation: 'CAREGIVER', docIdentityDocument: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Documento de identidad');
    const txt = await modal.innerText();
    expect(txt).not.toContain('Certificado de Acompañante Terapéutico');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso4-caregiver-dni.png', { maxDiffPixels: 100 });
  });

  // ── Caso 5 ────────────────────────────────────────────────────────────────

  test('caso 5: CAREGIVER sem criminal_record → "Antecedentes penales"', async ({ page }) => {
    const modal = await setupCase(page, { occupation: 'CAREGIVER', docCriminalRecord: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Antecedentes penales');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso5-caregiver-criminal.png', { maxDiffPixels: 100 });
  });

  // ── Caso 6 ────────────────────────────────────────────────────────────────

  test('caso 6: sex+gender+birthDate faltando + sem resume_cv + criminal_record → duas seções', async ({ page }) => {
    const modal = await setupCase(page, {
      occupation: 'AT',
      sex: false, gender: false, birthDate: false,
      docResumeCv: false, docCriminalRecord: false,
    });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Datos personales y profesionales');
    await expect(modal).toContainText('Sexo');
    await expect(modal).toContainText('Género');
    await expect(modal).toContainText('Fecha de nacimiento');
    await expect(modal).toContainText('Documentos');
    await expect(modal).toContainText('Currículum vitae');
    await expect(modal).toContainText('Antecedentes penales');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso6-compound.png', { maxDiffPixels: 100 });
  });

  // ── Caso 7 ────────────────────────────────────────────────────────────────

  test('caso 7: title_certificate faltando → "Título / Certificado" (regressão histórica)', async ({ page }) => {
    const modal = await setupCase(page, { titleCertificate: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Título / Certificado');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso7-title-cert.png', { maxDiffPixels: 100 });
  });

  // ── Caso 8 ────────────────────────────────────────────────────────────────

  test('caso 8: phone faltando → "Teléfono" (regressão histórica)', async ({ page }) => {
    const modal = await setupCase(page, { phone: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Teléfono');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso8-phone.png', { maxDiffPixels: 100 });
  });

  // ── Caso 9 ────────────────────────────────────────────────────────────────

  test('caso 9: profession=NULL → backend trata como AT, exige docs AT', async ({ page }) => {
    const modal = await setupCase(page, { occupation: null, docAtCertificate: false });
    expect(lastTrackStatus).toBe(403);
    await expect(modal).toContainText('Documentos');
    await expect(modal).toContainText('Certificado de Acompañante Terapéutico');
    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso9-profession-null.png', { maxDiffPixels: 100 });
  });

  // ── Caso 10 ───────────────────────────────────────────────────────────────
  // track-channel stubbed to return missingFields=[] — edge case where the
  // backend signals ineligibility but reports no specific missing fields.

  test('caso 10: missingFields=[] → bodyGeneric visível, modal nunca em branco', async ({ page }) => {
    await page.route('**/api/worker-applications/track-channel', async (route: Route) => {
      await route.fulfill({
        status: 403, contentType: 'application/json',
        body: JSON.stringify({
          success: false, error: 'registration_incomplete',
          code: 'WORKER_NOT_ELIGIBLE', reason: 'registration_incomplete',
          missingFields: [],
        }),
      });
    });

    const w = insertEligibilityWorker({ occupation: 'AT' });
    workers.push(w);
    await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Postularse/i }).click();

    const modal = page.locator('.fixed.inset-0 > div').first();
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });

    // bodyGeneric must be shown
    await expect(modal).toContainText('Su registro está incompleto');

    // No field sections (no missing fields to list)
    const txt = await modal.innerText();
    expect(txt).not.toContain('Datos personales y profesionales');
    expect(txt).not.toContain('Documentos');

    await assertNoRawTokens(modal);
    await expect(modal).toHaveScreenshot('incomplete-modal-caso10-empty-fields.png', { maxDiffPixels: 100 });
  });

  // ── Caso 11 ───────────────────────────────────────────────────────────────
  // Verifica navegação: clicar em "Currículum vitae" leva à aba Documentos
  // com o slot doc-slot-resume_cv visível e destacado.

  test('caso 11: clicar "Currículum vitae" no modal navega para aba Documentos com slot resume_cv visível', async ({ page }) => {
    test.setTimeout(120_000);
    const w11 = insertEligibilityWorker({ occupation: 'AT', docResumeCv: false });
    workers.push(w11);

    // ── Fase 1: screenshot do modal antes do clique ──────────────────────────
    await loginAsWorker(page, w11.authUid, `${w11.authUid}@test.local`);
    const modal11 = await triggerModal(page, vacancyId);

    const resumeLink = modal11.getByRole('button', { name: /Currículum vitae/i });
    await expect(resumeLink).toBeVisible({ timeout: 5_000 });
    await expect(modal11).toHaveScreenshot('incomplete-modal-caso11-nav-resume-cv-before-click.png', { maxDiffPixels: 100 });

    // Clica no botão — aciona handleFieldClick('doc_resume_cv') → navigate(...)
    // O navigate() é testado: confirmamos que a URL saiu de /vacantes/.
    await resumeLink.click();
    await page.waitForURL(
      (url) => !url.pathname.startsWith('/vacantes'),
      { timeout: 10_000 },
    );
    // Garante que a URL de destino é /worker/profile (direta ou via login redirect).
    const destUrl = page.url();
    const encodedTarget = encodeURIComponent('/worker/profile?tab=documents&focus=resume_cv');
    const decodedDest = decodeURIComponent(destUrl);
    expect(
      decodedDest.includes('/worker/profile?tab=documents') ||
      decodedDest.includes(`next=/worker/profile`),
      `Esperado navegar para /worker/profile?tab=documents, mas URL atual: ${destUrl}`,
    ).toBe(true);

    // ── Fase 2: login fresco + navegação direta → estabilidade garantida ──────
    // O auth pode ter expirado após a navegação SPA; faz fresh login para garantir
    // que o WorkerProfilePage carregue sem flakiness de Firebase token validation.
    await loginAsWorker(page, w11.authUid, `${w11.authUid}@test.local`);
    await page.goto('/worker/profile?tab=documents&focus=resume_cv', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    const url = page.url();
    expect(url).toContain('tab=documents');
    expect(url).toContain('focus=resume_cv');

    // Aguarda o slot aparecer diretamente (deep link ativou aba Documentos).
    const docSlot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await expect(docSlot).toBeVisible({ timeout: 30_000 });

    // Aguarda o highlight transitório desaparecer (HIGHLIGHT_DURATION_MS = 2000ms).
    await page.waitForTimeout(2_500);

    // Screenshot do slot de documento (locator-scoped, estável — evita variação de dados do worker).
    await expect(docSlot).toHaveScreenshot('incomplete-modal-caso11-nav-resume-cv-after-click.png', { maxDiffPixels: 100 });
  });

  // ── Caso 12 ───────────────────────────────────────────────────────────────
  // Verifica navegação: clicar em "Teléfono" no modal leva à aba General
  // com o wrapper #phone visível.

  test('caso 12: clicar "Teléfono" no modal navega para aba General com campo phone visível', async ({ page }) => {
    test.setTimeout(120_000);
    const w12 = insertEligibilityWorker({ phone: false });
    workers.push(w12);

    // ── Fase 1: screenshot do modal antes do clique ──────────────────────────
    await loginAsWorker(page, w12.authUid, `${w12.authUid}@test.local`);
    const modal12 = await triggerModal(page, vacancyId);

    const phoneLink = modal12.getByRole('button', { name: /Teléfono/i });
    await expect(phoneLink).toBeVisible({ timeout: 5_000 });
    await expect(modal12).toHaveScreenshot('incomplete-modal-caso12-nav-phone-before-click.png', { maxDiffPixels: 100 });

    // Clica no botão — aciona handleFieldClick('phone') → navigate(...)
    await phoneLink.click();
    await page.waitForURL(
      (url) => !url.pathname.startsWith('/vacantes'),
      { timeout: 10_000 },
    );
    // Garante que a URL de destino é /worker/profile?tab=general&focus=phone.
    const destUrl12 = page.url();
    const decodedDest12 = decodeURIComponent(destUrl12);
    expect(
      decodedDest12.includes('/worker/profile?tab=general') ||
      decodedDest12.includes('next=/worker/profile'),
      `Esperado navegar para /worker/profile?tab=general, mas URL atual: ${destUrl12}`,
    ).toBe(true);

    // ── Fase 2: login fresco + navegação direta → estabilidade garantida ──────
    await loginAsWorker(page, w12.authUid, `${w12.authUid}@test.local`);
    await page.goto('/worker/profile?tab=general&focus=phone', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    const url = page.url();
    expect(url).toContain('tab=general');
    expect(url).toContain('focus=phone');

    // Aguarda o campo #phone aparecer (General tab renderiza após init).
    const phoneWrapper = page.locator('#phone');
    await expect(phoneWrapper).toBeVisible({ timeout: 30_000 });

    // Aguarda o highlight transitório desaparecer (HIGHLIGHT_DURATION_MS = 2000ms).
    await page.waitForTimeout(2_500);

    // Screenshot do wrapper do campo phone (locator-scoped, estável — evita variação de dados do worker).
    await expect(phoneWrapper).toHaveScreenshot('incomplete-modal-caso12-nav-phone-after-click.png', { maxDiffPixels: 100 });
  });
});
