/**
 * postularse-iniciado-043.integration.e2e.ts @integration
 *
 * Spec 043 (D474): só o CLIQUE em "Postularse" cria o Iniciado; o bloqueado entra em
 * Iniciados com a tag BLOQUEADO e borda vermelha.
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. O endpoint
 * /api/worker-applications/track-channel NÃO é mockado: a decisão (200 elegível / 403 barrado)
 * vem do gate do backend. O Kanban é lido como ADMIN, em outro contexto de navegador.
 *
 * Cenários:
 *   FELIZ — worker elegível com WJA source='system' INVITED (convidado) abre
 *           /vacantes/<id>?utm_source=whatsapp e clica em Postularse → no Kanban da vaga o
 *           card dele está em kanban-column-INICIADO (M6: o clique vira postulação).
 *   ALT1  — worker com cadastro incompleto clica em Postularse → card com badge BLOQUEADO em
 *           kanban-column-INICIADO, borda vermelha lida por getComputedStyle, e NADA dele em
 *           REJECTED (M2/M5/A3).
 *   ALT2  — worker logado abre a página com utm_source e NÃO clica → nenhuma chamada a
 *           track-channel, nenhuma WJA nem tentativa bloqueada no banco, nenhum card no Kanban
 *           (M1/A1).
 *
 * Cada teste usa a PRÓPRIA vaga e o PRÓPRIO worker (os workers do helper têm todos o mesmo nome).
 *
 * Pré-condições: docker (postgres + api) + pnpm dev. Run: pnpm test:e2e:integration -g "043"
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  setWorkerStatus,
  getWorkerStatusByAuthUid,
  getBlockedApplicationChannel,
} from '../helpers/eligibility-worker-helper';
import { insertWJA, getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';
import { loginAsKanbanAdmin, openKanban } from '../helpers/talentumWebhookHelper';

const WHATSAPP_URL = 'https://wa.me/5491155550430';
const RED_500 = 'rgb(239, 68, 68)';
const SLATE_200 = 'rgb(226, 232, 240)';

/** Captura window.open (o redirect do WhatsApp) sem abrir aba real. */
async function captureWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((u?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(u));
      return null;
    }) as typeof window.open;
  });
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []);
}

/** Conta as chamadas a track-channel que saem da página (request, não só resposta). */
function countTrackChannelRequests(page: Page): () => number {
  let n = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/worker-applications/track-channel')) n += 1;
  });
  return () => n;
}

/** Abre o Kanban da vaga como ADMIN, em um contexto separado do worker. */
async function openKanbanAsAdmin(browser: Browser, baseURL: string | undefined, vacancyId: string) {
  const adminContext = await browser.newContext({
    baseURL: baseURL ?? 'http://localhost:5173',
    viewport: { width: 1920, height: 1080 },
  });
  const adminPage = await adminContext.newPage();
  await loginAsKanbanAdmin(adminPage);
  await openKanban(adminPage, vacancyId);
  return { adminContext, adminPage };
}

function countRows(sql: string): number {
  return Number(runSQL(sql));
}

test.describe('043 — só o clique em Postularse cria Iniciado; bloqueado em Iniciados @integration', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  const vacancies: string[] = [];
  const workerIds: string[] = [];

  test.afterAll(() => {
    for (const w of workerIds) cleanupEligibilityWorker(w);
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  // ── FELIZ ────────────────────────────────────────────────────────────────────
  test('feliz — convidado (WJA system INVITED) clica em Postularse → card em INICIADO', async ({ page, browser, baseURL }) => {
    const vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: WHATSAPP_URL });
    vacancies.push(vacancyId);

    // Worker elegível: cadastro completo + REGISTERED (o guard do banco confere os campos).
    const w = insertEligibilityWorker({ occupation: 'AT' });
    workerIds.push(w.workerId);
    setWorkerStatus(w.workerId, 'REGISTERED');
    expect(getWorkerStatusByAuthUid(w.authUid), 'pré-condição: worker elegível (REGISTERED)').toBe('REGISTERED');

    // Convite do match: a linha nasce ANTES do clique, source='system', etapa INVITED.
    const wjaId = insertWJA({
      workerId: w.workerId,
      jobPostingId: vacancyId,
      funnelStage: 'INVITED',
      source: 'system',
      acquisitionChannel: 'system',
    });
    expect(getWjaByWorkerAndJob(w.workerId, vacancyId)?.funnelStage).toBe('INVITED');
    expect(
      runSQL(`SELECT source FROM worker_job_applications WHERE id = '${wjaId}'`),
      'pré-condição: a linha é do convite (source=system)',
    ).toBe('system');

    await captureWindowOpen(page);
    const tracks = countTrackChannelRequests(page);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);

    await page.goto(`/vacantes/${vacancyId}?utm_source=whatsapp`, { waitUntil: 'networkidle', timeout: 30_000 });
    const postularse = page.getByRole('button', { name: /Postularse/i });
    await expect(postularse).toBeVisible({ timeout: 15_000 });
    expect(tracks(), 'abrir a página não chama track-channel (M1)').toBe(0);

    await postularse.click();
    await expect.poll(async () => (await openedUrls(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await openedUrls(page), 'elegível → abre o WhatsApp da vaga').toContain(WHATSAPP_URL);
    expect(tracks(), 'o clique chamou track-channel exatamente uma vez').toBe(1);

    // M6: a linha do convite virou postulação (mesma linha, source='manual'). O canal fica o do
    // convite ('system'): acquisition_channel é first-touch (CreateManualWjaWithEncuadreUseCase,
    // ON CONFLICT só preenche se NULL) — o utm_source do clique não sobrescreve.
    expect(
      runSQL(`SELECT source || '|' || COALESCE(acquisition_channel, '') FROM worker_job_applications WHERE id = '${wjaId}'`),
      'a linha do convite virou postulação, canal do convite preservado (first-touch)',
    ).toBe('manual|system');

    const { adminContext, adminPage } = await openKanbanAsAdmin(browser, baseURL, vacancyId);
    try {
      const card = adminPage.locator(
        `[data-testid="kanban-column-INICIADO"] [data-testid="kanban-card-${wjaId}"]`,
      );
      await expect(card, 'o convidado que clicou está em INICIADO').toBeVisible({ timeout: 15_000 });
      await expect(card).toHaveAttribute('data-stage', 'INICIADO');
      await expect(
        card.locator('[data-testid="blocked-badge"]'),
        'worker elegível: card normal, sem badge BLOQUEADO',
      ).toHaveCount(0);
      await expect(
        adminPage.locator(`[data-testid="kanban-column-INVITED"] [data-testid="kanban-card-${wjaId}"]`),
        'saiu de Invitados',
      ).toHaveCount(0);
      const border = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(border, 'card elegível não tem a borda vermelha (M5)').not.toBe(RED_500);
      await expect(adminPage.locator('[data-testid="kanban-column-INICIADO"]')).toHaveScreenshot(
        'postularse-043-feliz-iniciado.png',
        { maxDiffPixelRatio: 0.05 },
      );
    } finally {
      await adminContext.close();
    }
  });

  // ── ALT1 ─────────────────────────────────────────────────────────────────────
  test('alt1 — cadastro incompleto clica em Postularse → card BLOQUEADO com borda vermelha em INICIADO, nada em REJECTED', async ({ page, browser, baseURL }) => {
    const vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: WHATSAPP_URL });
    vacancies.push(vacancyId);

    // Sem nome, sem sexo e sem telefone → o gate devolve 403 e grava a tentativa bloqueada.
    const w = insertEligibilityWorker({ occupation: 'AT', firstName: false, lastName: false, sex: false, phone: false });
    workerIds.push(w.workerId);

    await captureWindowOpen(page);
    const tracks = countTrackChannelRequests(page);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);

    await page.goto(`/vacantes/${vacancyId}?utm_source=whatsapp`, { waitUntil: 'networkidle', timeout: 30_000 });
    const postularse = page.getByRole('button', { name: /Postularse/i });
    await expect(postularse).toBeVisible({ timeout: 15_000 });
    expect(tracks(), 'abrir a página não chama track-channel (M1)').toBe(0);
    expect(
      countRows(`SELECT count(*) FROM worker_blocked_applications WHERE job_posting_id = '${vacancyId}'`),
      'antes do clique não há tentativa bloqueada',
    ).toBe(0);

    await postularse.click();
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
    expect(await openedUrls(page), 'bloqueado: o WhatsApp NÃO abre').toHaveLength(0);
    expect(tracks(), 'o clique chamou track-channel exatamente uma vez').toBe(1);

    const wbaId = runSQL(
      `SELECT id FROM worker_blocked_applications WHERE worker_id = '${w.workerId}' AND job_posting_id = '${vacancyId}'`,
    );
    expect(wbaId, 'o gate gravou a tentativa bloqueada').toMatch(/^[0-9a-f-]{36}$/i);
    expect(getBlockedApplicationChannel(w.workerId, vacancyId), 'canal do clique na tentativa').toBe('whatsapp');

    const { adminContext, adminPage } = await openKanbanAsAdmin(browser, baseURL, vacancyId);
    try {
      const card = adminPage.locator(
        `[data-testid="kanban-column-INICIADO"] [data-testid="kanban-card-${wbaId}"]`,
      );
      await expect(card, 'a tentativa bloqueada está em INICIADO').toBeVisible({ timeout: 15_000 });
      await expect(card).toHaveAttribute('data-stage', 'INICIADO');
      await expect(card.locator('[data-testid="blocked-badge"]'), 'badge BLOQUEADO').toBeVisible();
      await expect(card.locator('[data-testid="blocked-badge"]')).toHaveText(/BLOQUEADO/);

      // 043 A3: o card bloqueado NÃO oferece "Invitar a reunión de presentación"
      // (o clique manda WhatsApp e nada no envio confere o cadastro).
      await expect(
        card.locator('[data-testid="presentation-invite-button"]'),
        'card bloqueado sem o convite de presentación',
      ).toHaveCount(0);

      // M5/A3: borda lida pelo estilo CALCULADO, não pela classe.
      const border = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(border, 'borda do card bloqueado é vermelha').toBe(RED_500);
      expect(border, 'e não o slate do card normal').not.toBe(SLATE_200);
      await expect(adminPage.locator('[data-testid="kanban-column-INICIADO"]')).toHaveScreenshot(
        'postularse-043-alt1-bloqueado-iniciado.png',
        { maxDiffPixelRatio: 0.05 },
      );

      // Nada do worker em REJECTED (a tentativa não foi dispensada).
      const rejected = adminPage.locator('[data-testid="kanban-column-REJECTED"]');
      await expect(rejected.locator(`[data-testid="kanban-card-${wbaId}"]`)).toHaveCount(0);
      await expect(rejected.locator('[data-testid="blocked-badge"]')).toHaveCount(0);
      await expect(adminPage.locator('[data-testid="kanban-column-REJECTED-count"]')).toHaveText('0');
    } finally {
      await adminContext.close();
    }
  });

  // ── ALT2 ─────────────────────────────────────────────────────────────────────
  test('alt2 — abrir a página com utm_source e NÃO clicar → nenhuma WJA, nenhuma tentativa, nenhum card', async ({ page, browser, baseURL }) => {
    const vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: WHATSAPP_URL });
    vacancies.push(vacancyId);

    const w = insertEligibilityWorker({ occupation: 'AT' });
    workerIds.push(w.workerId);
    setWorkerStatus(w.workerId, 'REGISTERED');
    expect(getWorkerStatusByAuthUid(w.authUid), 'pré-condição: worker elegível (REGISTERED)').toBe('REGISTERED');

    await captureWindowOpen(page);
    const tracks = countTrackChannelRequests(page);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);

    await page.goto(`/vacantes/${vacancyId}?utm_source=whatsapp`, { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({ timeout: 15_000 });
    // O utm_source continua guardado para o clique, mas nada vai ao servidor.
    expect(
      await page.evaluate(() => sessionStorage.getItem('enlite_utm_source')),
      'o utm_source fica na sessão, para o clique',
    ).toBe('whatsapp');
    // Dá tempo a qualquer efeito tardio (o antigo disparava ao carregar a vaga).
    await page.waitForTimeout(3_000);

    expect(tracks(), 'abrir a página NÃO chama track-channel').toBe(0);
    expect(await openedUrls(page), 'nem abre o WhatsApp').toHaveLength(0);
    expect(
      countRows(`SELECT count(*) FROM worker_job_applications WHERE job_posting_id = '${vacancyId}'`),
      'nenhuma WJA nova no banco',
    ).toBe(0);
    expect(
      countRows(`SELECT count(*) FROM worker_blocked_applications WHERE job_posting_id = '${vacancyId}'`),
      'nenhuma tentativa bloqueada no banco',
    ).toBe(0);

    const { adminContext, adminPage } = await openKanbanAsAdmin(browser, baseURL, vacancyId);
    try {
      // O board está montado e nenhuma coluna tem card desta vaga.
      await expect(adminPage.locator('[data-testid="kanban-board"]')).toBeVisible();
      await expect(adminPage.locator('[data-testid="kanban-column-INICIADO-count"]')).toHaveText('0');
      await expect(adminPage.locator('[data-testid="kanban-column-REJECTED-count"]')).toHaveText('0');
      await expect(adminPage.locator('[data-testid^="kanban-card-"][data-stage]')).toHaveCount(0);
      await expect(adminPage.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
        'postularse-043-alt2-board-vazio.png',
        { maxDiffPixelRatio: 0.05 },
      );
    } finally {
      await adminContext.close();
    }
  });
});
