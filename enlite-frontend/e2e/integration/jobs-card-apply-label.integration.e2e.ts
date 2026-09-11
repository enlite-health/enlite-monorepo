/**
 * jobs-card-apply-label.integration.e2e.ts @integration
 *
 * Fase 4 de postulacao-documento-pendente (DD5 · consome F1/F2/F3): o botão
 * "Postularse" do card da vaga (`JobsEmbeddedSection`) passa a nomear o que
 * falta — "Subí {documento} para postularte" (1 pendência de documento),
 * "Completá {N} pasos para postularte" (2+), ou "Postularse" original
 * (completo, ou completude não apurada). "Termina quando" de `fase-4.md`.
 *
 * ATUALIZAÇÃO (rodada "home vagas API pública", autorizada por Gabriel): o
 * critério de "Correção a" abaixo (11/09) foi SUPERADO — não é mais o texto
 * histórico, é a decisão vigente. Naquela rodada, o clique em Postularse não
 * chamava track-channel porque os cards vinham do scraper legado (sem
 * job_posting_id real). Agora a home usa a API pública (job com `id` real)
 * e Postularse passa pelo MESMO `usePostularseAction` de /vacantes/:id
 * (JobCard.tsx, canal fixo 'site') — o clique CHAMA track-channel de
 * verdade, e o modal que aparece vem do 403 do servidor (missingFields
 * fresco), não mais só da prop. Só "Ver Detalles" continua nunca chamando
 * track-channel (condição C1 do lex, inalterada — ver
 * home-postularse-incomplete.integration.e2e.ts). Prova de banco completa
 * (worker_blocked_applications/worker_job_applications, channel='site') vive
 * em home-vagas-api-publica.integration.e2e.ts; aqui o teste "feliz" só
 * confirma que a request AO SERVIDOR acontece (1, não 0) — o foco deste
 * arquivo continua sendo o rótulo dinâmico e o contraste.
 *
 * Correção b do orquestrador: o Nº de pendências vem de `buildPendingRows`
 * — a MESMA função que `PendingTasksCard` usa — nunca uma segunda contagem.
 * Prova disso: o teste "alt" confere que o botão e a lista de tarefas, na
 * MESMA tela, dizem o MESMO número.
 *
 * Passo 0 (medido): `missingFields` chega por PROP (do GET /api/workers/me
 * que a home já busca pra si), sem requisição nova por card — provado
 * contando requests com 2+ vagas na lista.
 *
 * ⚠️ Massa real da stage: nenhuma vaga lá tem `whatsappLink` (o card
 * "Postularse" não aparece de verdade na stage hoje) — este teste semeia a
 * própria vaga com `insertMinimalVacancy` (mesmo helper que
 * `home-postularse-incomplete.integration.e2e.ts` já usa), via
 * `/api/public/v1/jobs` (toggle `__USE_PUBLIC_JOBS_API`, dado REAL do
 * banco desta worktree — não é page.route de dado).
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration
 *      --grep "jobs-card-apply-label"
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
import { readTextContrastRatio } from '../helpers/contrast-helper';

test.use({ video: 'on' });

/** WCAG AA, texto pequeno (< 18pt/24px ou < 14pt/18.5px bold). */
const WCAG_AA_MIN_CONTRAST = 4.5;

test.describe('@integration Card da vaga — rótulo dinâmico do Postularse (Fase 4, DD5)', () => {
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

  test('feliz — 1 pendência de documento (antecedentes): botão nomeia, clique chama track-channel (1x, 403) e abre o modal com o retorno do servidor', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });

    const trackChannelRequests: Request[] = [];
    let trackStatus: number | null = null;
    page.on('request', (req) => {
      if (req.url().includes('track-channel')) trackChannelRequests.push(req);
    });
    page.on('response', (r) => {
      if (r.url().includes('track-channel')) trackStatus = r.status();
    });

    await loginAndGoHome(page, w);

    const applyBtn = page.getByRole('button', { name: 'Subí Antecedentes penales para postularte' }).first();
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });

    // Achado do gate (11/09, rodada 3): o botão "Postularse" (bg-[#25d366],
    // identidade WhatsApp) mede 1,98:1 sobre o texto branco — bem abaixo do
    // mínimo WCAG AA (4,5:1) — e agora carrega a frase inteira da entrega,
    // não só uma palavra curta. Mede o PRÓPRIO botão (o helper começa pelo
    // elemento passado — aqui o fundo colorido É do botão, não de um
    // wrapper sem cor, lição da Fase 3/rodada 2 do gate).
    const applyBtnContrast = await readTextContrastRatio(applyBtn);
    expect(applyBtnContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST);

    // `:hover` de verdade (pseudo-classe do navegador, não estado JS) —
    // `getComputedStyle` já reflete `hover:bg-[#054C44]` com o mouse em
    // cima. `transition-colors` do Tailwind anima a troca (~150ms
    // default) — espera passar pra não capturar uma cor NO MEIO da
    // transição.
    await applyBtn.hover();
    await page.waitForTimeout(300);
    const applyBtnHoverContrast = await readTextContrastRatio(applyBtn);
    expect(applyBtnHoverContrast).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST);

    await applyBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Ir a Antecedentes penales/i })).toBeVisible();

    // Postularse agora passa pelo servidor (usePostularseAction, JobCard.tsx)
    // — exatamente 1 request, e o servidor bloqueia com 403 (worker
    // INCOMPLETE_REGISTER). Prova de banco completa (worker_blocked_applications,
    // channel='site') vive em home-vagas-api-publica.integration.e2e.ts.
    expect(trackChannelRequests).toHaveLength(1);
    expect(trackStatus).toBe(403);

    await expect(page.locator('[data-testid="incomplete-modal-pending-list"]')).toHaveScreenshot(
      'fase4-modal-1-documento.png',
      { maxDiffPixels: 200 },
    );
  });

  test('alt — 3 pendências: botão diz "Completá 3 pasos para postularte" e a lista de tarefas na MESMA tela diz "Te faltan 3 pasos" (MESMO N, buildPendingRows compartilhado)', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    // phone (registro) + doc_criminal_record + doc_identity_document (2 documentos) = 3 linhas.
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      phone: false,
      docCriminalRecord: false,
      docIdentityDocument: false,
    });
    await loginAndGoHome(page, w);

    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Te faltan 3 pasos para postularte')).toBeVisible();

    const applyBtn = page.getByRole('button', { name: 'Completá 3 pasos para postularte' }).first();
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });

    // Screenshot do CARD inteiro (a vaga é semeada por este teste — dado
    // determinístico, sem precisar de mask). Prova visual do rótulo
    // "Completá 3 pasos para postularte" no botão de verdade, junto com
    // "Te faltan 3 pasos" da lista de tarefas logo acima — os DOIS na
    // mesma imagem, o MESMO número.
    await expect(page.locator('[data-testid="pending-tasks-card"]')).toHaveScreenshot(
      'fase4-lista-de-tarefas-3-pendencias.png',
      { maxDiffPixels: 200 },
    );
    await expect(applyBtn).toHaveScreenshot('fase4-botao-3-pendencias.png', { maxDiffPixels: 100 });
  });

  test('alt — cadastro completo: botão volta a dizer "Postularse" (rótulo original)', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'CAREGIVER' }); // todos os campos/docs default=true
    await loginAndGoHome(page, w);

    await expect(page.locator('[data-testid="pending-tasks-card"]')).toHaveCount(0);
    const applyBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });
  });

  test('Passo 0 — missingFields chega por PROP: o Nº de requests a /api/workers/me NÃO escala com o Nº de cards', async ({ page }) => {
    // Isolamento: os testes anteriores deste ARQUIVO semeiam vaga própria e
    // só limpam em `afterAll` — sem isto, a contagem de botões abaixo
    // pegaria vagas de testes anteriores (visíveis na MESMA listagem
    // pública) e falharia por vazamento entre testes, não por defeito.
    while (vacancies.length > 0) cleanupMinimalVacancy(vacancies.pop()!);

    // Não afirma um número LITERAL de requests (o dev server roda em
    // React.StrictMode, que dobra o efeito de montagem — um artefato do
    // AMBIENTE de teste, não do código). A prova robusta é COMPARATIVA:
    // o nº de chamadas a /api/workers/me com 1 vaga na tela tem de ser
    // IGUAL ao nº de chamadas com 5 — se algum card fizesse a própria
    // requisição, o segundo número cresceria junto.
    function countWorkersMeRequests(): { requests: Request[]; stop: () => void } {
      const requests: Request[] = [];
      const handler = (req: Request): void => {
        const url = req.url();
        if (url.includes('/api/workers/me') && !url.includes('/api/workers/me/')) requests.push(req);
      };
      page.on('request', handler);
      return { requests, stop: () => page.off('request', handler) };
    }

    const vacancyId1 = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId1);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    await loginAndGoHome(page, w);
    await expect(page.getByRole('button', { name: 'Subí Antecedentes penales para postularte' })).toHaveCount(1);

    const baseline = countWorkersMeRequests();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: 'Subí Antecedentes penales para postularte' })).toHaveCount(1);
    baseline.stop();
    expect(baseline.requests.length).toBeGreaterThan(0); // a captura funcionou

    // +4 vagas (5 no total) — mesmo worker, mesma página, só mais cards.
    vacancies.push(
      insertMinimalVacancy({ includeInPublicListing: true }),
      insertMinimalVacancy({ includeInPublicListing: true }),
      insertMinimalVacancy({ includeInPublicListing: true }),
      insertMinimalVacancy({ includeInPublicListing: true }),
    );

    const withFiveCards = countWorkersMeRequests();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: 'Subí Antecedentes penales para postularte' })).toHaveCount(5);
    withFiveCards.stop();

    expect(withFiveCards.requests.length).toBe(baseline.requests.length);
  });
});
