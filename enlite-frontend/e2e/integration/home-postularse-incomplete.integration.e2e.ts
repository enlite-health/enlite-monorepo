/**
 * home-postularse-incomplete.integration.e2e.ts @integration
 *
 * CAMADA 0 — bug #2 (versão sem servidor novo, parecer lex 10/09): clicar
 * "Postularse"/"Ver Detalles" na HOME com cadastro incompleto abria um modal
 * genérico que não nomeava o que faltava e não reaproveitava o caminho real
 * de /vacantes/:id. Os dois botões passaram a abrir o MESMO
 * IncompleteRegistrationModal.
 *
 * ATUALIZAÇÃO (rodada "home vagas API pública", autorizada por Gabriel):
 * "Ver Detalles" continua usando a prop `missingFields` (GET /api/workers/me)
 * e NUNCA chama track-channel (LEX C1, inalterado — teste "alt" abaixo).
 * "Postularse" MUDOU: agora chama o servidor de verdade por clique
 * (usePostularseAction/JobCard.tsx, canal fixo 'site') — o modal que aparece
 * vem do 403 fresco do track-channel, não mais só da prop (que pode estar
 * desatualizada). Os testes "feliz"/"alt — falta telefone" abaixo continuam
 * passando sem mudança de asserção porque o servidor usa a MESMA função
 * (fn_worker_missing_fields) que o GET /api/workers/me — o conteúdo do
 * modal é idêntico, só a fonte mudou.
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. A lista
 * de vagas vem de /api/public/v1/jobs (dado real do banco, via o toggle de
 * teste window.__USE_PUBLIC_JOBS_API — não é page.route de dado, é escolher
 * qual endpoint REAL a home consulta) — o scraper legado /api/jobs bate num
 * WordPress externo de verdade e não entra em teste automatizado.
 *
 * Pré-condições: docker (postgres + api) + pnpm dev. Run: pnpm test:e2e:integration
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' });

test.describe('@integration Home — Postularse/Ver Detalles com cadastro incompleto (bug #2)', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];
  const vacancies: string[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
  }

  test('feliz — AT sem antecedentes e sem CV clica Postularse → modal nomeia os DOIS documentos → "Ir a Antecedentes penales" cai na aba, no slot certo, com o aviso nomeando "Antecedentes penales"', async ({ page }) => {
    // Fase 1 (DD1, postulacao-documento-pendente): GET /api/workers/me deixou
    // de devolver o agregado `worker_documents` — devolve os `doc_*`
    // específicos (mesmo detalhe que o 403 do track-channel já dava). Com
    // DOIS documentos faltando, o modal nomeia OS DOIS, não mais um item
    // genérico "Documentos" (i18n real, es.json: fields.doc_criminal_record=
    // "Antecedentes penales", fields.doc_resume_cv="Currículum vitae").
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false, docResumeCv: false });
    await loginAndGoHome(page, w);

    // Fase 4/DD5: com 2 documentos pendentes (antecedentes + CV), o rótulo
    // do botão deixa de ser "Postularse" — vira "Completá 2 pasos para
    // postularte" (buildApplyLabel, mesma contagem de buildPendingRows que
    // a lista de tarefas da home usa). O CLIQUE continua o MESMO — ainda
    // abre o modal que nomeia, sem request pra track-channel.
    const postularseBtn = page.getByRole('button', { name: 'Completá 2 pasos para postularte' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await postularseBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const criminalRecordItem = page.getByRole('button', { name: /Ir a Antecedentes penales/i });
    const resumeCvItem = page.getByRole('button', { name: /Ir a Currículum vitae/i });
    await expect(criminalRecordItem).toBeVisible();
    await expect(resumeCvItem).toBeVisible();

    await expect(page.locator('[data-testid="incomplete-modal-pending-list"]')).toHaveScreenshot(
      'home-incomplete-modal-at-docs.png',
      { maxDiffPixels: 200 },
    );

    await criminalRecordItem.click();
    // focus=criminal_record: leva ao slot ESPECÍFICO do documento clicado, não
    // só à aba (destinationFor('doc_criminal_record') → { tab: 'documents',
    // focus: 'criminal_record' }, incompleteFieldDestinations.ts).
    await expect(page).toHaveURL(/\/worker\/profile\?tab=documents&focus=criminal_record/, { timeout: 15_000 });

    const notice = page.locator('[data-testid="at-required-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('Antecedentes penales');
  });

  test('alt — falta telefone → modal nomeia "Teléfono" e leva à aba geral', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', phone: false });
    await loginAndGoHome(page, w);

    // Fase 4/DD5: 1 pendência de REGISTRO (phone → aba general) → "Completá
    // Información General para postularte".
    const postularseBtn = page.getByRole('button', { name: 'Completá Información General para postularte' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await postularseBtn.click();

    const phoneItem = page.getByRole('button', { name: /Ir a Teléfono/i });
    await expect(phoneItem).toBeVisible({ timeout: 10_000 });
    await phoneItem.click();

    await expect(page).toHaveURL(/\/worker\/profile\?tab=general&focus=phone/, { timeout: 15_000 });
    const generalTab = page.locator('[data-testid="tab-btn-general"]');
    await expect(generalTab).toBeVisible({ timeout: 15_000 });
    await expect(generalTab).toHaveScreenshot('home-incomplete-modal-phone-general-tab.png', { maxDiffPixels: 200 });
  });

  test('alt — "Ver Detalles" com cadastro incompleto abre o MESMO modal e NENHUMA request pra track-channel', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });

    const trackChannelRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('track-channel')) trackChannelRequests.push(req);
    });

    await loginAndGoHome(page, w);

    const detailsBtn = page.getByRole('button', { name: 'Ver Detalles' }).first();
    await expect(detailsBtn).toBeVisible({ timeout: 15_000 });

    // O link externo da vaga NUNCA deve abrir com cadastro incompleto —
    // interceptamos popup pra provar que nenhuma nova aba/navegação ocorre.
    let popupOpened = false;
    page.once('popup', () => { popupOpened = true; });

    await detailsBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="incomplete-modal-pending-list"]')).toHaveScreenshot(
      'home-incomplete-modal-ver-detalles.png',
      { maxDiffPixels: 200 },
    );

    expect(popupOpened).toBe(false);
    expect(trackChannelRequests).toHaveLength(0);
  });

  // D1 (QA caça, rodada 4, incidente 08/09) — ATUALIZADO na rodada "home
  // vagas API pública": a versão ORIGINAL deste teste atrasava o GET
  // /api/workers/me pra provar que a home não afirma "incompleto" sobre uma
  // completude que ainda não tinha chegado (a decisão de completude vinha de
  // uma PROP local, sujeita à corrida entre dois fetches independentes).
  //
  // Essa classe de corrida deixou de EXISTIR: Postularse agora chama o
  // servidor DIRETO por clique (usePostularseAction/JobCard.tsx), sem
  // depender do GET /api/workers/me da home nem da prop `missingFields` — um
  // worker REGISTERED completo abre o WhatsApp normalmente mesmo que aquele
  // GET ainda esteja em voo (comportamento CORRETO, não mais um bug: prova
  // disso é o caso "elegível" de home-vagas-api-publica.integration.e2e.ts).
  //
  // O que CONTINUA valendo (mesmo princípio, ponto de incerteza NOVO): a
  // home nunca pode afirmar "Registro incompleto" nem abrir o WhatsApp
  // quando o PRÓPRIO check de elegibilidade (agora o round-trip real pro
  // track-channel) falha por erro de servidor/rede. Este teste passa a
  // simular ISSO — interceptando track-channel (não mais /api/workers/me)
  // pra devolver 500 — com um worker REGISTERED completo, provando que
  // mesmo assim a home fica fail-closed.
  test('erro do servidor no check de elegibilidade (track-channel 500) → mensagem de verificação, NÃO "incompleto", WhatsApp não abre (fail-closed)', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    // Worker REGISTERED de verdade — sem a falha simulada abaixo, esta
    // worker é elegível e o WhatsApp abriria. A prova é que o ERRO do
    // servidor bloqueia mesmo assim, sem afirmar "incompleto".
    const w = insertEligibilityWorker({ occupation: 'CAREGIVER' });
    workers.push(w);

    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);

    // Registrada DEPOIS do loginNewWorker: rotas do Playwright disparam na
    // ordem INVERSA de registro (a mais recente primeiro), então esta é a
    // que intercepta a chamada — sem tocar no restante do fluxo (login,
    // GET /api/workers/me, lista de vagas) que segue 100% real.
    await page.route('**/api/worker-applications/track-channel', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal error' }),
      });
    });

    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });

    const postularseBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });

    let popupOpened = false;
    page.once('popup', () => { popupOpened = true; });

    await postularseBtn.click();

    // Texto REAL (es.json), o mesmo que /vacantes/:id usa pro estado "não
    // verificado" — nunca "Registro incompleto".
    const verifyTitle = page.getByRole('heading', { name: 'No pudimos verificar tu registro' });
    await expect(verifyTitle).toBeVisible({ timeout: 5_000 });
    // Texto PRÓPRIO da home (rodada 5, D1) — o texto padrão fala em WhatsApp
    // e "Completá tu registro o intentá nuevamente", que não fazem sentido
    // aqui (Ver Detalles não abre WhatsApp; não há CTA de completar/retry).
    await expect(page.getByText('No pudimos verificar tu registro en este momento. Volvé a intentarlo en unos minutos.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Registro incompleto' })).toHaveCount(0);
    // Sem CTA de completar registro — não dá pra mandar completar algo que
    // talvez já esteja completo.
    await expect(page.getByRole('button', { name: 'Completar registro' })).toHaveCount(0);

    await expect(page.locator('[data-testid="postularse-error-modal-card"]')).toHaveScreenshot(
      'home-completeness-unknown-modal.png',
      { maxDiffPixels: 200 },
    );

    expect(popupOpened).toBe(false);
  });
});
