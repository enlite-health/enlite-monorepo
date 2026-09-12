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
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

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

interface Box { x: number; y: number; width: number; height: number }

/** Retângulos se sobrepõem (área de interseção > 0, não só encostam na borda). */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  await loginAsWorker(page, w.authUid, `${w.authUid}@test.local`);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
}

/**
 * Variante com `loginNewWorker` (worker-realreg-auth-helper.ts): passa
 * `/api/workers/me` de verdade pro backend (ao contrário de `loginAsWorker`,
 * que estuba esse endpoint sem `missingFields`). Necessário pros testes de
 * layout mobile abaixo — o defeito do print só aparece com o rótulo
 * DINÂMICO longo (Fase 4/DD5, "Completá N pasos para postularte"), que só
 * chega com missingFields real (mesmo padrão de jobs-card-apply-label.integration.e2e.ts).
 */
async function loginAndGoHomeWithRealLabel(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
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

  // ── Defeito visual mobile (print depois-1-home-celular.png, 390px): o botão
  // ── verde ficava POR CIMA do badge do código, e "Ver Detalles" cortava na
  // ── borda direita do card. Prova GEOMÉTRICA (boundingBox), não só visual —
  // ── um toHaveScreenshot sozinho acusa a MUDANÇA, não o DEFEITO em si.
  test('mobile (390×844) — badge do código, botão verde e "Ver Detalles" não se sobrepõem, e "Ver Detalles" fica inteiro dentro do card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const vacancyId = insertMinimalVacancy({
      talentumWhatsappUrl: 'https://wa.me/5491100000104',
      includeInPublicListing: true,
    });
    vacancies.push(vacancyId);
    // 2 pendências (mesmo cenário do print: "Completá 2 pasos para postularte")
    // — precisa do rótulo DINÂMICO longo pra reproduzir o defeito (o rótulo
    // curto "Postularse" cabe sem problema em 390px; loginAndGoHomeWithRealLabel
    // usa loginNewWorker pra deixar missingFields real chegar via GET /api/workers/me).
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false, docResumeCv: false });
    workers.push(w);

    await loginAndGoHomeWithRealLabel(page, w);

    const card = page.locator('[data-testid="job-card"]').first();
    const badge = card.locator('[data-testid="job-code-badge"]');
    const applyBtn = card.getByRole('button', { name: /postularte/i });
    const detailsBtn = card.getByRole('button', { name: 'Ver Detalles' });
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });
    await expect(detailsBtn).toBeVisible();

    const cardBox = await card.boundingBox();
    const badgeBox = await badge.boundingBox();
    const applyBox = await applyBtn.boundingBox();
    const detailsBox = await detailsBtn.boundingBox();
    expect(cardBox && badgeBox && applyBox && detailsBox, 'todas as boundingBox precisam existir').toBeTruthy();

    expect(overlaps(badgeBox!, applyBox!), 'badge do código não pode ficar sob o botão verde').toBe(false);
    expect(overlaps(badgeBox!, detailsBox!), 'badge do código não pode ficar sob "Ver Detalles"').toBe(false);
    expect(overlaps(applyBox!, detailsBox!), 'os dois botões não podem se sobrepor entre si').toBe(false);

    // "Ver Detalles" inteiro dentro da largura do card (nada cortado pela borda).
    // Epsilon de 1px pro arredondamento de subpixel do layout engine.
    expect(detailsBox!.x, '"Ver Detalles" não pode começar antes da borda esquerda do card').toBeGreaterThanOrEqual(cardBox!.x - 1);
    expect(
      detailsBox!.x + detailsBox!.width,
      '"Ver Detalles" não pode terminar depois da borda direita do card',
    ).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);

    // Escopado no CARD (não a página inteira): o describe block só limpa
    // workers/vagas em afterAll — vagas de outros testes deste arquivo
    // acumulam na listagem real enquanto os testes rodam em sequência, e uma
    // screenshot de página inteira pegaria essa variação (não-determinística
    // por ORDEM de execução), sem ligação nenhuma com o defeito sob teste.
    await expect(card).toHaveScreenshot('home-card-mobile-390.png', { maxDiffPixels: 1000 });
  });

  test('desktop — layout do card sem mudança visual além do esperado (viewport largo, botões na mesma linha do badge)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const vacancyId = insertMinimalVacancy({
      talentumWhatsappUrl: 'https://wa.me/5491100000105',
      includeInPublicListing: true,
    });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false, docResumeCv: false });
    workers.push(w);

    await loginAndGoHomeWithRealLabel(page, w);

    const card = page.locator('[data-testid="job-card"]').first();
    const badge = card.locator('[data-testid="job-code-badge"]');
    const applyBtn = card.getByRole('button', { name: /postularte/i });
    const detailsBtn = card.getByRole('button', { name: 'Ver Detalles' });
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });

    const badgeBox = await badge.boundingBox();
    const applyBox = await applyBtn.boundingBox();
    // Em desktop os botões continuam na MESMA linha (topo) do badge —
    // aproximadamente a mesma faixa vertical, não empilhados como no mobile.
    expect(Math.abs(badgeBox!.y - applyBox!.y)).toBeLessThan(12);
    expect(overlaps(badgeBox!, applyBox!)).toBe(false);
    expect(overlaps(applyBox!, (await detailsBtn.boundingBox())!)).toBe(false);

    // Mesmo motivo do teste mobile: escopado no CARD, não na página inteira.
    await expect(card).toHaveScreenshot('home-card-desktop.png', { maxDiffPixels: 1000 });
  });
});
