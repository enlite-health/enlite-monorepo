/**
 * home-vagas-api-publica.integration.e2e.ts @integration
 *
 * Nova tarefa (autorizada por Gabriel): a home passa a usar a API pública
 * (`/api/public/v1/jobs`, toggle `window.__USE_PUBLIC_JOBS_API`) como fonte
 * de vagas na STAGE, e "Postularse" passa a checar elegibilidade REAL no
 * servidor — o MESMO `usePostularseAction` de /vacantes/:id, canal fixo
 * 'site' (não é UTM), via `JobCard.tsx`.
 *
 * Outbound confirmado seguro por leitura de código (CreateManualWjaWithEncuadreUseCase.ts,
 * migration 189, docs/features/worker-job-applications/08-pipelines.md pipeline
 * #3): a criação de WJA/encuadre nesse caminho não emite domain event nem
 * escreve em messaging_outbox — só 2 INSERTs SQL idempotentes. O caso
 * "elegível" abaixo cria uma WJA de verdade no Postgres; o clique no
 * WhatsApp é neutralizado via `trackWindowOpen` (nunca navega pra wa.me).
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real.
 * `loginAsWorker` (worker-auth-helper.ts) — MESMO helper de
 * postularse-whatsapp-gate.integration.e2e.ts: estuba /api/workers/me
 * (dado mínimo, sem missingFields — por isso o rótulo do botão fica sempre
 * "Postularse" aqui, nunca o dinâmico da Fase 4/DD5) mas deixa
 * /api/worker-applications/track-channel passar de verdade pro backend.
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration
 *      --grep "home vagas API pública"
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import {
  insertEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupEligibilityWorker,
  setWorkerStatus,
  getBlockedApplicationChannel,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { loginAsWorker } from '../helpers/worker-auth-helper';

/**
 * Injeta um interceptor de window.open que NUNCA abre aba e registra as URLs
 * em window.__openedUrls — MESMO padrão de postularse-whatsapp-gate.integration.e2e.ts.
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

async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
}

test.use({ video: 'on' });

test.describe('@integration Home — vagas da API pública, Postularse pelo servidor (canal "site")', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];
  const vacancies: string[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  test('feliz — worker com cadastro incompleto clica Postularse → modal nomeia a pendência E linha nova em worker_blocked_applications (Postgres real) com channel=\'site\'', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({
      talentumWhatsappUrl: 'https://wa.me/5491100000101',
      includeInPublicListing: true,
    });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    workers.push(w);

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAndGoHome(page, w);

    const postularseBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await postularseBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Antecedentes penales/i })).toBeVisible();
    expect(trackStatus, 'track-channel deve bloquear com 403 (worker INCOMPLETE_REGISTER)').toBe(403);

    // Prova de banco: linha nova em worker_blocked_applications, canal 'site'
    // (fixo — não é UTM). Lida direto do Postgres, não inferida da UI.
    await expect
      .poll(() => getBlockedApplicationChannel(w.workerId, vacancyId), { timeout: 10_000 })
      .toBe('site');

    await expect(page.locator('[data-testid="incomplete-modal-pending-list"]')).toHaveScreenshot(
      'home-vagas-api-publica-blocked-modal.png',
      { maxDiffPixels: 200 },
    );
  });

  test('alt — worker REGISTERED (elegível) → WJA criada no Postgres real (channel=\'site\', stage=INVITED) e o link do WhatsApp "abre" (window.open neutralizado, nunca navega pra wa.me de verdade)', async ({ page }) => {
    await trackWindowOpen(page);
    const whatsappUrl = 'https://wa.me/5491100000102';
    const vacancyId = insertMinimalVacancy({
      talentumWhatsappUrl: whatsappUrl,
      includeInPublicListing: true,
    });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({}); // todos os campos + docs
    setWorkerStatus(w.workerId, 'REGISTERED');
    workers.push(w);

    let trackStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) trackStatus = r.status();
    });

    await loginAndGoHome(page, w);

    const postularseBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="jobs-list"]')).toHaveScreenshot(
      'home-vagas-api-publica-elegible-antes-do-clique.png',
      { maxDiffPixels: 300 },
    );

    await postularseBtn.click();

    await expect.poll(async () => (await getOpenedUrls(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(trackStatus, 'worker elegível → 200').toBe(200);
    const opened = await getOpenedUrls(page);
    expect(opened, 'WhatsApp deve "abrir" (neutralizado) com a URL real da vaga').toContain(whatsappUrl);

    // Prova de banco: WJA de verdade, criada pelo MESMO caminho da Luz/link
    // público (CreateManualWjaWithEncuadreUseCase) — confirmado por leitura
    // de código que não dispara mensagem real (sem domain event, sem
    // messaging_outbox — ver cabeçalho do arquivo).
    await expect
      .poll(() => getWjaByWorkerAndJob(w.workerId, vacancyId)?.id ?? null, { timeout: 10_000 })
      .not.toBeNull();
    const wja = getWjaByWorkerAndJob(w.workerId, vacancyId);
    expect(wja?.acquisitionChannel).toBe('site');
    expect(wja?.funnelStage).toBe('INVITED');
  });

  test('alt — "Ver Detalles" NUNCA chama track-channel (condição C1 do lex), mesmo estando na home com a API pública ligada', async ({ page }) => {
    await trackWindowOpen(page);
    const vacancyId = insertMinimalVacancy({
      talentumWhatsappUrl: 'https://wa.me/5491100000103',
      includeInPublicListing: true,
    });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    workers.push(w);

    const trackChannelRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('track-channel')) trackChannelRequests.push(req);
    });

    await loginAndGoHome(page, w);

    const detailsBtn = page.getByRole('button', { name: 'Ver Detalles' }).first();
    await expect(detailsBtn).toBeVisible({ timeout: 15_000 });
    await detailsBtn.click();

    // "Ver Detalles" com cadastro incompleto (missingFields não apurado, já
    // que loginAsWorker estuba /api/workers/me sem esse campo) mostra o
    // aviso de verificação — não é o foco deste teste, só confirma que o
    // link externo não abriu por engano. getByRole('heading', ...) evita
    // ambiguidade com o parágrafo do corpo, que repete o mesmo texto.
    await expect(page.getByRole('heading', { name: /No pudimos verificar tu registro/i })).toBeVisible({ timeout: 10_000 });

    expect(trackChannelRequests, 'Ver Detalles jamais chama track-channel').toHaveLength(0);
    const opened = await getOpenedUrls(page);
    expect(opened).toHaveLength(0);
  });
});
