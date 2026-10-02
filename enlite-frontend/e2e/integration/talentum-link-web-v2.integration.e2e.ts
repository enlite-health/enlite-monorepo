/**
 * talentum-link-web-v2.integration.e2e.ts @integration
 *
 * spec 040 / F4 / T4.3 — e2e de TELA do link de pré-seleção da Talentum v2 (stub, nunca a Talentum real).
 * A v2 devolve um link WEB (`.../public/pre-screening/<publicId>/chat`), não um link de bot WhatsApp:
 *
 *   1. FELIZ — foguete → borrador → wizard (digitado com `keyboard.type`, nunca `fill`) → "Publicar en
 *      Talentum": o card da vaga mostra o rótulo "Link de preselección web" e a URL v2 (valor LIDO da
 *      tela, sem `wa.me`); o botão do card ("Abrir link") aponta para a MESMA URL; na página pública
 *      `/vacantes/:id`, um prestador elegível clica "Postularse" e o `window.open` recebe essa URL.
 *   2. ALTERNATIVO — o stub recusa o `POST /projects` (500): a tela mostra a mensagem de erro, fica em
 *      `/talentum` e o card NÃO mostra link algum.
 *   3. ALTERNATIVO — vaga sem link: a página pública mostra "Postularse" DESABILITADO + a mensagem de
 *      indisponível, e o clique não abre nada.
 *
 * Único mock de navegador: `/generate-ai-content` (Gemini custaria). `publish-talentum` vai ao backend,
 * que vai ao stub (porta 9914). Massa sintética; nenhum canal real.
 */
import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  clickFoguete,
  completeDraftViaWizard,
  publishOnTalentumPage,
  mockAdminUserFor,
  useLancamentoStaff,
  loginAndMockAi,
  LANCAMENTO_VIEWPORT_ES_AR,
  type TalentumStub,
} from '../helpers/lancamento-e2e-helper';
import {
  insertEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupEligibilityWorker,
  setWorkerStatus,
} from '../helpers/eligibility-worker-helper';
import { loginAsWorker } from '../helpers/worker-auth-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('linkweb');
const WEB_LINK = /https:\/\/www\.v2\.talentum\.chat\/public\/pre-screening\/[0-9a-f-]{36}\/chat/;

/** `window.open` nunca abre aba: registra a URL em `window.__openedUrls` (molde do WhatsApp gate). */
async function trackWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

// Vídeo fica no topo do arquivo: `test.use({ video })` dentro de describe força worker novo e o Playwright recusa.
test.use({ video: 'on' });

test.describe('talentum link web v2 @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(150_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Talentum Link Web F4');

  let stub: TalentumStub;
  test.beforeAll(async () => {
    stub = await startTalentumStub();
  });
  test.afterAll(async () => {
    await stub.close();
  });

  test('talentum-link-web-feliz: publicar pela tela → card com link web v2 → Postularse abre o mesmo link', async ({
    page,
    browser,
    baseURL,
    request,
  }, testInfo) => {
    stub.mode = 'accept';
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -54.8019, lng: -68.303 });
    const worker = insertEligibilityWorker({}); // completo…
    setWorkerStatus(worker.workerId, 'REGISTERED'); // …e REGISTERED: elegível (molde do controle D do gate)
    let workerCtx: BrowserContext | undefined;
    try {
      await loginAndMockAi(page, MOCK_ADMIN_USER);
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);
      await completeDraftViaWizard(page, vacancyId);

      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      // ── o card (aba Talentum da vaga) mostra o link WEB v2 (valor LIDO da tela) ──
      await page.getByRole('button', { name: 'Talentum', exact: true }).click();
      await expect(page.getByText('Link de preselección web')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Link del bot WhatsApp')).toHaveCount(0);
      const linkText = page.getByText(WEB_LINK);
      await expect(linkText).toBeVisible({ timeout: 15_000 });
      const shownUrl = ((await linkText.textContent()) ?? '').trim();
      expect(shownUrl, 'URL lida da tela é o link web v2').toMatch(WEB_LINK);
      expect(shownUrl, 'nunca wa.me').not.toContain('wa.me');
      await expect(page.getByTitle('Abrir link')).toHaveAttribute('href', shownUrl);
      await linkText.scrollIntoViewIfNeeded();
      await shot(page, testInfo, '1-card-link-web-v2');

      // A vaga lançada nasce em ativação pendente (status que a rota pública não serve): a operação a
      // ativa — aqui por SQL, é só o passo de montagem — e então ela aparece em /vacantes/:id.
      runSQL(`UPDATE job_postings SET status = 'SEARCHING' WHERE id = '${vacancyId}'`);

      // ── página pública: prestador elegível clica Postularse → window.open recebe o MESMO link ──
      // contexto NOVO: sessão de prestador isolada da sessão admin (localStorage próprio)
      workerCtx = await browser.newContext({ ...LANCAMENTO_VIEWPORT_ES_AR, baseURL: baseURL ?? undefined });
      const workerPage = await workerCtx.newPage();
      await trackWindowOpen(workerPage);
      await loginAsWorker(workerPage, worker.authUid, `${worker.authUid}@test.local`);
      await workerPage.goto(`/vacantes/${vacancyId}`, { waitUntil: 'domcontentloaded' });
      const postularse = workerPage.getByRole('button', { name: /Postularse/i });
      await expect(postularse).toBeEnabled({ timeout: 15_000 });
      await shot(workerPage, testInfo, '2-publica-postularse-habilitado');
      await postularse.click();
      await expect.poll(async () => (await openedUrls(workerPage)).length, { timeout: 15_000 }).toBe(1);
      const opened = await openedUrls(workerPage);
      expect(opened[0], 'Postularse abre o link v2 mostrado no card').toBe(shownUrl);
      expect(opened[0]).not.toContain('wa.me');
    } finally {
      await workerCtx?.close();
      cleanupEligibilityWorker(worker.workerId);
      patient.cleanup();
    }
  });

  test('talentum-link-web-falha-do-stub: a Talentum recusa → mensagem na tela, sem link no card', async ({
    page,
    request,
  }, testInfo) => {
    stub.mode = 'reject';
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -51.6226, lng: -69.2181 });
    try {
      await loginAndMockAi(page, MOCK_ADMIN_USER);
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);
      await completeDraftViaWizard(page, vacancyId);

      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum com o stub recusando').toBe(502);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/talentum$`), { timeout: 10_000 });

      const errorText = page.locator('span.text-red-600.text-right');
      await expect(errorText).toBeVisible({ timeout: 10_000 });
      const message = ((await errorText.textContent()) ?? '').trim();
      expect(message.length, 'mensagem de erro lida da tela').toBeGreaterThan(0);
      await shot(page, testInfo, '3-falha-do-stub-mensagem');

      // sem link v2: nada do link na tela e nada gravado na vaga
      await expect(page.getByText(WEB_LINK)).toHaveCount(0);
      const savedUrl = runSQL(`SELECT COALESCE(talentum_whatsapp_url, '') FROM job_postings WHERE id = '${vacancyId}'`).trim();
      expect(savedUrl, 'talentum_whatsapp_url continua vazio depois da recusa').toBe('');
    } finally {
      stub.mode = 'accept';
      patient.cleanup();
    }
  });

  test('talentum-link-web-sem-link: vaga sem link → Postularse desabilitado e nada abre', async ({ page }, testInfo) => {
    const vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: '' });
    try {
      await trackWindowOpen(page);
      await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });
      const postularse = page.getByRole('button', { name: /Postularse/i });
      await expect(postularse).toBeVisible({ timeout: 15_000 });
      await expect(postularse).toBeDisabled();
      const msg = page.getByText(/aún no está disponible para postulación/i).first();
      await expect(msg).toBeVisible();
      await shot(page, testInfo, '4-publica-sem-link-desabilitado');
      await postularse.click({ force: true });
      expect(await openedUrls(page), 'sem link, nada abre').toHaveLength(0);
    } finally {
      cleanupMinimalVacancy(vacancyId);
    }
  });
});
