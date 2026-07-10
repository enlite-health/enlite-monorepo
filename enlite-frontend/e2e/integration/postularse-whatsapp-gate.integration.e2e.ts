/**
 * postularse-whatsapp-gate.integration.e2e.ts @integration
 *
 * INVARIANTE CRÍTICO (ClickUp 86ajfkwf7):
 *   "Nunca, sob nenhuma hipótese, um prestador sem cadastro completo pode
 *    avançar para o pré-screening do WhatsApp."
 *
 * Prova REAL: frontend real + backend real (gate de elegibilidade
 * `assertWorkerCanApply` roda de verdade) + Postgres real. O endpoint
 * `/api/worker-applications/track-channel` NÃO é mockado — a decisão
 * vem do banco. Cada teste intercepta `window.open` e prova que o WhatsApp
 * abriu (só no caso elegível) ou NÃO abriu (todos os bloqueios).
 *
 * Matriz:
 *   A) Worker com registro MÍNIMO (email/senha, tudo faltando) — reproduz o
 *      vídeo do report → track-channel 403 → modal "Registro incompleto",
 *      WhatsApp NÃO abre.
 *   B) Worker DISABLED → track-channel 403 → bloqueado, WhatsApp NÃO abre.
 *   C) Worker SEM fila no banco (auth existe, worker não) → track-channel
 *      responde erro sem WORKER_NOT_ELIGIBLE → fail-closed: modal de erro,
 *      WhatsApp NÃO abre. (Este é o exato caminho que o bug deixava passar.)
 *   D) Controle positivo — worker REGISTERED completo → track-channel 200 →
 *      WhatsApp ABRE (garante que o fix não sobre-bloqueia quem está ok).
 *
 * Pré-condições:
 *   cd worker-functions && docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev
 *
 * Run: pnpm test:e2e:integration -g "WhatsApp gate"
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupEligibilityWorker,
  setWorkerStatus,
  getWorkerStatusByAuthUid,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginAsWorker } from '../helpers/worker-auth-helper';

const WHATSAPP_URL = 'https://wa.me/5491100000009';

/** Todos os campos/documentos ausentes — o worker "só email/senha" do vídeo. */
const MINIMAL_WORKER_OPTS = {
  firstName: false, lastName: false, sex: false, gender: false, birthDate: false,
  documentNumber: false, languages: false, phone: false, knowledgeLevel: false,
  titleCertificate: false, yearsExperience: false, experienceTypes: false,
  preferredTypes: false, preferredAgeRange: false, serviceArea: false,
  availability: false, docResumeCv: false, docIdentityDocument: false,
  docCriminalRecord: false, docAtCertificate: false,
} as const;

/**
 * Injeta um interceptor de window.open que NUNCA abre aba e registra as URLs
 * em window.__openedUrls. addInitScript roda em toda navegação (antes do React
 * montar), então cobre o login + a navegação para /vacantes.
 */
async function trackWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

async function getOpenedUrls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? [],
  );
}

async function gotoVacancyAndPostularse(page: Page, vacancyId: string): Promise<void> {
  await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Postularse/i }).click();
}

test.describe('@integration Postularse WhatsApp gate — fail-closed (backend real)', () => {
  test.setTimeout(90_000);

  let vacancyId: string;
  const workers: InsertEligibilityWorkerResult[] = [];

  test.beforeAll(() => {
    vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: WHATSAPP_URL });
  });

  test.afterAll(() => {
    cleanupMinimalVacancy(vacancyId);
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  // ── A) Reprodução do vídeo: worker com registro mínimo ──────────────────────
  test('A) registro mínimo (como o vídeo) → 403 → gate, WhatsApp NÃO abre', async ({ page }) => {
    await trackWindowOpen(page);
    const w = insertEligibilityWorker({ ...MINIMAL_WORKER_OPTS });
    workers.push(w);

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
    await gotoVacancyAndPostularse(page, vacancyId);

    // Gate de cadastro incompleto aparece
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
    expect(trackStatus, 'track-channel deve bloquear com 403').toBe(403);

    // INVARIANTE: WhatsApp NÃO foi aberto
    const opened = await getOpenedUrls(page);
    expect(opened, 'WhatsApp nunca pode abrir para worker incompleto').toHaveLength(0);
    expect(opened).not.toContain(WHATSAPP_URL);

    await expect(page).toHaveScreenshot('whatsapp-gate-A-minimal-blocked.png', { maxDiffPixels: 200 });
  });

  // ── B) Worker DISABLED ──────────────────────────────────────────────────────
  test('B) worker DISABLED → 403 → bloqueado, WhatsApp NÃO abre', async ({ page }) => {
    await trackWindowOpen(page);
    const w = insertEligibilityWorker({}); // completo…
    setWorkerStatus(w.workerId, 'DISABLED'); // …mas desabilitado
    workers.push(w);

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
    await gotoVacancyAndPostularse(page, vacancyId);

    // DISABLED lança WorkerNotEligibleError (code WORKER_NOT_ELIGIBLE) → modal incompleto
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
    expect(trackStatus).toBe(403);

    const opened = await getOpenedUrls(page);
    expect(opened, 'WhatsApp nunca pode abrir para worker DISABLED').toHaveLength(0);

    await expect(page).toHaveScreenshot('whatsapp-gate-B-disabled-blocked.png', { maxDiffPixels: 200 });
  });

  // ── C) Worker sem fila no banco (404) → fail-closed error modal ──────────────
  test('C) sem fila no banco → erro não-elegível → fail-closed, WhatsApp NÃO abre', async ({ page }) => {
    await trackWindowOpen(page);
    // auth_uid que NÃO existe em workers — reproduz a janela entre criar conta
    // Firebase e a linha do worker existir (o caminho que o bug deixava passar).
    const ghostUid = `e2e-ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAsWorker(page, ghostUid, `${ghostUid}@test.local`);
    await gotoVacancyAndPostularse(page, vacancyId);

    // Fail-closed: NÃO é WORKER_NOT_ELIGIBLE → modal de erro (nunca WhatsApp)
    await expect(
      page.locator('text=/No pudimos verificar tu registro/i').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Backend bloqueia (404 worker-not-found ou 403 sem elegibilidade) — nunca 200
    expect(trackStatus, 'não pode ser sucesso').not.toBe(200);
    expect(trackStatus).not.toBeNull();

    const opened = await getOpenedUrls(page);
    expect(opened, 'WhatsApp nunca pode abrir sem confirmação de elegibilidade').toHaveLength(0);

    await expect(page).toHaveScreenshot('whatsapp-gate-C-ghost-failclosed.png', { maxDiffPixels: 200 });
  });

  // ── D) Controle positivo: worker REGISTERED completo → WhatsApp ABRE ─────────
  test('D) worker REGISTERED completo → 200 → WhatsApp ABRE (não sobre-bloqueia)', async ({ page }) => {
    await trackWindowOpen(page);
    const w = insertEligibilityWorker({}); // todos os campos + docs
    setWorkerStatus(w.workerId, 'REGISTERED');
    workers.push(w);

    // Prova de banco: o guard fn_guard_registered_status aceitou REGISTERED
    expect(
      getWorkerStatusByAuthUid(w.authUid),
      'worker completo deve persistir como REGISTERED no banco real',
    ).toBe('REGISTERED');

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
    await gotoVacancyAndPostularse(page, vacancyId);

    // Espera o track-channel resolver e o window.open ser chamado
    await expect.poll(async () => (await getOpenedUrls(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

    expect(trackStatus, 'worker elegível → 200').toBe(200);
    const opened = await getOpenedUrls(page);
    expect(opened, 'worker REGISTERED deve conseguir abrir o WhatsApp').toContain(WHATSAPP_URL);
  });
});
