/**
 * jobs-card-apply-label.integration.e2e.ts @integration
 *
 * ATUALIZAÇÃO 096 (regra do Gabriel: "vagas só são mostradas na home quando o cadastro estiver completo"): a home de prestador
 * INCOMPLETO não tem mais lista, então o rótulo "Subí {documento}" / "Completá {N} pasos" (`buildApplyLabel`, só existe em
 * `JobsEmbeddedSection`, que só a `WorkerHome` renderiza) ficou INALCANÇÁVEL para incompleto. Os cenários de incompleto abaixo
 * provam o BLOQUEIO; o rótulo original "Postularse", o contraste do botão e o Passo 0 seguem com prestador COMPLETO. O fluxo
 * "clique → 403 → modal que nomeia a pendência" continua alcançável em `/vacantes/:id` (PublicVacancyPage.tsx) e é provado em
 * `postularse-incomplete-modal` e `home-postularse-incomplete`.
 *
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
import { countJobsRouteCalls, expectHomeBlocked } from '../helpers/home-blocked-helper';

test.use({ video: 'on' });

/** WCAG AA, texto pequeno (< 18pt/24px ou < 14pt/18.5px bold). */
const WCAG_AA_MIN_CONTRAST = 4.5;

test.describe('@integration Card da vaga — rótulo do Postularse e bloqueio da home sem cadastro (096)', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];
  const vacancies: string[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  async function login(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
  }

  async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    await login(page, w);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
  }

  test('incompleto (1 documento: antecedentes) → home bloqueada: bloco genérico, sem lista, sem botão "Subí…", sem chamada a /workers/me/jobs', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    await login(page, w);
    const jobsCalls = countJobsRouteCalls(page);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });

    await expectHomeBlocked(page, jobsCalls);
    await expect(page.getByRole('button', { name: /para postularte/i })).toHaveCount(0);
    await expect(page.getByTestId('complete-profile-notice')).toHaveScreenshot('home-bloqueada-1-documento.png', { maxDiffPixels: 200 });
  });

  test('incompleto (3 pendências): o card de tarefas diz "Te faltan 3 pasos" e a home segue bloqueada, sem botão "Completá 3 pasos…"', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    // phone (registro) + doc_criminal_record + doc_identity_document (2 documentos) = 3 linhas.
    const w = insertEligibilityWorker({
      occupation: 'AT',
      phone: false,
      docCriminalRecord: false,
      docIdentityDocument: false,
    });
    await login(page, w);
    const jobsCalls = countJobsRouteCalls(page);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });

    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Te faltan 3 pasos para postularte')).toBeVisible();
    await expectHomeBlocked(page, jobsCalls);
    await expect(page.getByRole('button', { name: /Completá 3 pasos para postularte/ })).toHaveCount(0);
    await expect(card).toHaveScreenshot('fase4-lista-de-tarefas-3-pendencias.png', { maxDiffPixels: 200 });
  });

  test('cadastro completo: botão diz "Postularse" (rótulo original), com contraste AA (normal e hover) e o clique chama track-channel 1x', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT' }); // todos os campos/docs default=true; AT porque a vaga semeada exige AT (home por perfil, 096)

    const trackChannelRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('track-channel')) trackChannelRequests.push(req);
    });
    await loginAndGoHome(page, w);

    await expect(page.locator('[data-testid="pending-tasks-card"]')).toHaveCount(0);
    await expect(page.getByTestId('complete-profile-notice')).toHaveCount(0);
    const applyBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });

    // O botão "Postularse" (bg-[#25d366], identidade WhatsApp) mede o PRÓPRIO botão: o fundo colorido É dele (lição do gate 11/09).
    expect(await readTextContrastRatio(applyBtn)).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST);
    // `:hover` de verdade; espera a transição do Tailwind (~150ms) para não medir uma cor no meio dela.
    await applyBtn.hover();
    await page.waitForTimeout(300);
    expect(await readTextContrastRatio(applyBtn)).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST);

    await applyBtn.click();
    await expect.poll(() => trackChannelRequests.length, { timeout: 10_000 }).toBe(1);
  });

  test('Passo 0 — missingFields chega por PROP: o Nº de requests a /api/workers/me NÃO escala com o Nº de cards (prestador completo)', async ({ page }) => {
    // Isolamento: os testes anteriores deste ARQUIVO semeiam vaga própria e só limpam em `afterAll` — sem isto, a contagem de
    // botões abaixo pegaria vagas de testes anteriores (visíveis na MESMA listagem pública) e falharia por vazamento entre testes.
    while (vacancies.length > 0) cleanupMinimalVacancy(vacancies.pop()!);

    // Prova COMPARATIVA (o dev server roda em React.StrictMode e dobra o efeito de montagem): o nº de chamadas a /api/workers/me
    // com 1 vaga tem de ser IGUAL ao com 5 — se algum card fizesse a própria requisição, o segundo número cresceria.
    function countWorkersMeRequests(): { requests: Request[]; stop: () => void } {
      const requests: Request[] = [];
      const handler = (req: Request): void => {
        const url = req.url();
        if (url.includes('/api/workers/me') && !url.includes('/api/workers/me/')) requests.push(req);
      };
      page.on('request', handler);
      return { requests, stop: () => page.off('request', handler) };
    }

    vacancies.push(insertMinimalVacancy({ includeInPublicListing: true }));
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await loginAndGoHome(page, w);
    await expect(page.getByRole('button', { name: 'Postularse' })).toHaveCount(1);

    const baseline = countWorkersMeRequests();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: 'Postularse' })).toHaveCount(1);
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
    await expect(page.getByRole('button', { name: 'Postularse' })).toHaveCount(5);
    withFiveCards.stop();

    expect(withFiveCards.requests.length).toBe(baseline.requests.length);
  });
});
