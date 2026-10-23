/**
 * home-postularse-can-apply-067.integration.e2e.ts @integration — spec 067 (FR-14, FR-15): o botão "Postularse" da home aparece por `can_apply`.
 *
 * E2E DE TELA, sem mock de resposta: frontend (home com a API pública ligada) + API + Postgres reais (USE_MOCK_AUTH=true), clique de humano.
 * SQL só MONTA o cenário: 2 vagas públicas — A com link da Talentum (`can_apply=true`), B com o link VAZIO (`can_apply=false`). O prestador
 * é APTO (REGISTERED + documentos validados), para que o clique em A chegue ao 200 de track-channel. `window.open` é neutralizado
 * (nenhuma aba, nenhum WhatsApp): só registramos a URL que a tela tentaria abrir.
 *
 *  FELIZ — a vaga A (can_apply=true) mostra "Postularse"; clicar chama track-channel (200) e a tela "abre" o link que VEIO DA RESPOSTA do
 *          servidor (FR-14: o link não está na listagem, só no 200 da postulação aprovada).
 *  ALT 1 — a vaga B (can_apply=false) NÃO mostra "Postularse" — o card só tem "Ver Detalles" — e nenhum clique nele chama track-channel.
 *  ALT 2 — a listagem pública (a mesma que a home consome) traz `can_apply` true/false e NENHUM link do WhatsApp/Talentum em nenhuma vaga.
 *
 * Outbound: nenhum (o fluxo só cria a candidatura local; o link do WhatsApp nunca é aberto). Dados SINTÉTICOS (@test.local), sem PII.
 * Pré-condições: API em localhost:8080 (USE_MOCK_AUTH=true), Vite em localhost:5173 (VITE_USE_PUBLIC_JOBS_API=true), Postgres em `E2E_PG_CONTAINER`.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  insertAptoWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { cardDaVagaNaHome } from '../helpers/bloqueados-067-helper';
import { BACKEND_URL } from '../helpers/talentumWebhookHelper';

const LINK_A = 'https://wa.me/5491100000671';
const vacancies: string[] = [];
const workers: InsertEligibilityWorkerResult[] = [];
let vagaA = '';
let vagaB = '';
let w: InsertEligibilityWorkerResult;

async function neutralizarWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

const urlsAbertas = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []);

async function entrarNaHome(page: Page): Promise<void> {
  await page.addInitScript(() => { (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true; });
  await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
}

test.describe('@integration Home — "Postularse" por can_apply (spec 067 FR-14/FR-15)', () => {
  test.use({ viewport: { width: 1400, height: 1000 } });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    vagaA = insertMinimalVacancy({ talentumWhatsappUrl: LINK_A, includeInPublicListing: true });
    vagaB = insertMinimalVacancy({ talentumWhatsappUrl: '', includeInPublicListing: true });
    vacancies.push(vagaA, vagaB);
    w = insertAptoWorker({ docs: 'validated' });
    workers.push(w);
  });

  test.afterAll(() => {
    for (const x of workers) {
      runSQL(`DELETE FROM worker_job_applications WHERE worker_id = '${x.workerId}'`);
      runSQL(`DELETE FROM encuadres WHERE worker_id = '${x.workerId}'`);
      cleanupEligibilityWorker(x.workerId);
    }
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  test('FELIZ — can_apply=true: o card mostra "Postularse"; o clique chama track-channel (200) e abre o link que veio da RESPOSTA', async ({ page }) => {
    await neutralizarWindowOpen(page);
    const respostas: Array<{ status: number; corpo: string }> = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) respostas.push({ status: r.status(), corpo: await r.text().catch(() => '') });
    });
    await entrarNaHome(page);

    const card = cardDaVagaNaHome(page, vagaA);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const postularse = card.getByRole('button', { name: 'Postularse' });
    await expect(postularse).toBeVisible();
    await expect(card.getByRole('button', { name: 'Ver Detalles' })).toBeVisible();
    await expect(card).toHaveScreenshot('home-can-apply-067-feliz-com-botao.png', { maxDiffPixelRatio: 0.05, mask: [page.getByTestId('job-code-badge')] });

    await postularse.click();
    await expect.poll(async () => (await urlsAbertas(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(respostas.map((r) => r.status), 'track-channel: uma chamada, 200').toEqual([200]);
    expect(respostas[0].corpo, 'o link vem no corpo do 200 de track-channel').toContain(LINK_A);
    expect(await urlsAbertas(page), 'a tela "abre" o link da resposta').toContain(LINK_A);
  });

  test('ALT 1 — can_apply=false: o card NÃO mostra "Postularse" (só "Ver Detalles") e nenhum clique nele chama track-channel', async ({ page }) => {
    await neutralizarWindowOpen(page);
    let trackChannel = 0;
    page.on('request', (r) => { if (r.url().includes('/api/worker-applications/track-channel')) trackChannel += 1; });
    await entrarNaHome(page);

    const card = cardDaVagaNaHome(page, vagaB);
    await expect(card, 'a vaga sem link continua na listagem').toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Ver Detalles' })).toBeVisible();
    await expect(card.getByRole('button', { name: /Postularse|postularte/ })).toHaveCount(0);
    await expect(card).toHaveScreenshot('home-can-apply-067-alt1-sem-botao.png', { maxDiffPixelRatio: 0.05, mask: [page.getByTestId('job-code-badge')] });

    await card.getByRole('button', { name: 'Ver Detalles' }).click();
    await page.waitForTimeout(500);
    expect(trackChannel, 'nenhum clique nesta vaga chama track-channel').toBe(0);
    // "Ver Detalles" pode abrir a página pública da vaga; o que NUNCA abre é um link de WhatsApp/Talentum (esse só vem do 200 de track-channel)
    expect((await urlsAbertas(page)).filter((u) => u.includes('wa.me') || u === LINK_A)).toEqual([]);
  });

  test('ALT 2 — a listagem pública traz can_apply true/false e NENHUM link do WhatsApp/Talentum em nenhuma vaga (FR-14)', async ({ request }) => {
    const r = await request.get(`${BACKEND_URL}/api/public/v1/jobs`);
    expect(r.status()).toBe(200);
    const bruto = await r.text();
    const jobs = (JSON.parse(bruto) as { data: Array<{ id: string; can_apply?: boolean }> }).data;
    expect(jobs.length, 'a listagem não está vazia (as 2 vagas semeadas estão nela)').toBeGreaterThanOrEqual(2);
    const a = jobs.find((j) => j.id === vagaA);
    const b = jobs.find((j) => j.id === vagaB);
    expect(a?.can_apply, 'vaga com link: can_apply=true').toBe(true);
    expect(b?.can_apply, 'vaga sem link: can_apply=false').toBe(false);
    expect(bruto, 'o link da Talentum não sai na listagem').not.toContain(LINK_A);
    expect(bruto, 'nenhum wa.me na listagem').not.toContain('wa.me/');
    expect(bruto, 'nenhum campo whatsapp_url na listagem').not.toContain('whatsapp_url');
  });
});
