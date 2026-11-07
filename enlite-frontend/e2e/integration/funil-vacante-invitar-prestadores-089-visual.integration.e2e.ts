/**
 * funil-vacante-invitar-prestadores-089-visual.integration.e2e.ts
 *
 * Caso 13 da §9.8 da spec 089 (T044, CA-12): UM `toHaveScreenshot` por estado do inventário do canvas, a 1440×900,
 * com o mapa mascarado (`mask: [points-map]` — tiles do Google variam por run). Mesmo seed/stack/gestos do arquivo
 * irmão (`funil-vacante-invitar-prestadores-089.integration.e2e.ts`): só click/hover/keyboard, nenhuma interceptação.
 *
 * Baselines: `*-integration-linux.png`, geradas na imagem do CI (mcr.microsoft.com/playwright:v1.58.2-jammy).
 * O CI roda `--ignore-snapshots`: aqui a baseline é guarda LOCAL e fonte dos prints da revisão lado a lado (T047).
 *
 * `E2E_089_PRINTS=1` grava, ALÉM da comparação, o print SEM máscara (mapa visível) de cada estado em
 * `E2E_089_PRINTS_DIR` (padrão `test-results/prints-089`). Desligado por padrão.
 *
 * E1 (cargando): o POST é rápido; o estado só existe por centenas de ms e `toHaveScreenshot` (2 capturas iguais) falhou
 * 1 em 5 runs. Fica só o print (E2E_089_PRINTS=1) e a asserção de que o esqueleto aparece; sem baseline.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { seedInvitar089, startPeriskopeStub, type Invitar089Seed, type PeriskopeStub } from '../helpers/invitar-prestadores-089-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-invitar-089-visual',
  email: 'staff.invitar.089.visual@e2e.test',
  role: 'admin',
  country: 'AR',
};

const ENTRY = 'invite-entry-button';
const PRINTS = process.env.E2E_089_PRINTS === '1';
const PRINTS_DIR = process.env.E2E_089_PRINTS_DIR ?? 'test-results/prints-089';

/** Para o print sem máscara: espera o mapa sair de `loading` e, se `ready`, carregar os tiles (melhor esforço, 15 s). */
async function settleMap(page: Page): Promise<void> {
  const map = page.getByTestId('points-map');
  if ((await map.count()) === 0) return;
  await expect.poll(async () => (await map.getAttribute('data-map-status')) ?? 'loading', { timeout: 30_000 }).not.toBe('loading');
  if ((await map.getAttribute('data-map-status')) === 'ready') {
    await expect(map).toHaveAttribute('data-tiles', 'loaded', { timeout: 15_000 }).catch(() => undefined);
  }
}

/** Compara com a baseline (mapa mascarado) e, com `E2E_089_PRINTS=1`, grava o print sem máscara. */
async function shot(page: Page, state: string): Promise<void> {
  if (PRINTS) await settleMap(page);
  if (PRINTS) {
    mkdirSync(PRINTS_DIR, { recursive: true });
    await page.screenshot({ path: `${PRINTS_DIR}/${state}.png`, fullPage: false, animations: 'disabled' });
  }
  await expect(page).toHaveScreenshot(`${state}.png`, {
    fullPage: false,
    mask: [page.getByTestId('points-map')],
    maxDiffPixelRatio: 0.02,
    animations: 'disabled',
  });
}

async function gotoVacancy(page: Page, vacancyId: string): Promise<void> {
  await page.goto(`/admin/vacancies/${vacancyId}?tab=encuadres`);
  await expect(page.getByTestId(ENTRY)).toBeVisible({ timeout: 30_000 });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByTestId('invite-rows')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('points-map')).toBeVisible({ timeout: 30_000 });
}

async function openInvite(page: Page, vacancyId: string): Promise<void> {
  await gotoVacancy(page, vacancyId);
  await page.getByTestId(ENTRY).click();
  await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/match`));
  await waitReady(page);
}

async function stepIs(page: Page, step: string): Promise<void> {
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-step', step, { timeout: 30_000 });
}

test.use({ video: 'off' });

test.describe('funil da vacante — Invitar prestadores, visual por estado (089 T044, caso 13) @visual @integration', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' });
  test.setTimeout(240_000);
  test.describe.configure({ mode: 'default' });

  let stub: PeriskopeStub;
  let seed: Invitar089Seed;

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Invitar 089 Visual');
    stub = startPeriskopeStub();
  });
  test.afterAll(() => {
    stub.server.close();
    cleanupMockStaff(MOCK_STAFF);
  });
  test.beforeEach(() => {
    seed = seedInvitar089();
  });
  test.afterEach(() => {
    seed.cleanup();
  });

  test('13-E0 botão "Invitar prestadores" na vacante', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await gotoVacancy(page, seed.vacancyA.vacancyId);
    await expect(page.getByTestId('invite-entry-count')).toHaveText(String(seed.pending.length));
    await shot(page, 'E0-botao-na-vacante');
  });

  test('13-E1 cargando (esqueleto) — só print, sem baseline (instável por natureza)', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await gotoVacancy(page, seed.vacancyA.vacancyId);
    await page.getByTestId(ENTRY).click();
    await expect(page.getByTestId('invite-loading-status')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('invite-list-skeleton')).toBeVisible();
    if (PRINTS) {
      mkdirSync(PRINTS_DIR, { recursive: true });
      await page.screenshot({ path: `${PRINTS_DIR}/E1-cargando.png`, fullPage: false, animations: 'disabled' });
    }
    // Sem `toHaveScreenshot`: o POST responde em centenas de ms e a captura estável (2 prints iguais) cai dentro dessa
    // janela só às vezes (medido: 1 falha em 5 runs). Segurar a resposta exigiria interceptar a rede, o que é proibido.
    test.info().annotations.push({ type: 'E1', description: 'sem baseline: carga rápida demais para captura estável' });
  });

  test('13-E2 passo "Ya en la vacante"', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await openInvite(page, seed.vacancyA.vacancyId);
    await stepIs(page, 'vacante');
    await expect(page.getByTestId('invite-guide')).toContainText('Estas personas ya están en la vacante');
    await shot(page, 'E2-ya-en-la-vacante');
  });

  test('13-E3 passo 5 km (1440; prints também a 1280 e 1920)', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await openInvite(page, seed.vacancyA.vacancyId);
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    await expect(page.getByTestId('invite-list-title')).toHaveText('Hasta 5 km del servicio');
    await shot(page, 'E3-hasta-5-km');
    if (PRINTS) {
      for (const [w, h] of [[1280, 800], [1920, 1080]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await expect(page.getByTestId('invite-rows')).toBeVisible();
        await settleMap(page);
        await page.screenshot({ path: `${PRINTS_DIR}/E3-hasta-5-km-${w}.png`, fullPage: false, animations: 'disabled' });
      }
    }
  });

  test('13-E4/E5/E6 confirmar, enviado e terminar (fluxo único)', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await openInvite(page, seed.vacancyA.vacancyId);
    await stepIs(page, 'vacante');
    // "Ya en la vacante" enviado → fundo do E4 do canvas (passo vacante concluído)
    await page.getByTestId('invite-btn-invite').click();
    await page.getByTestId('invite-confirm-send').click();
    await expect(page.getByTestId('invite-confirm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('invite-sent-alert')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });
    await page.getByTestId('invite-btn-more-primary').click();
    await stepIs(page, '5');
    await expect(page.getByTestId('invite-list-title')).toHaveText('Hasta 5 km del servicio');

    // E4 — confirmação com já convidados do passo (caixa "Enviársela otra vez" desmarcada)
    await page.getByTestId('invite-btn-invite').click();
    await expect(page.getByTestId('invite-confirm-dialog')).toBeVisible();
    await shot(page, 'E4-confirmar');

    // E5 — enviado
    await page.getByTestId('invite-confirm-send').click();
    await expect(page.getByTestId('invite-confirm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('invite-sent-alert')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('invite-sent-alert')).toContainText('Listo: invitaste a 4 personas');
    await shot(page, 'E5-enviado');

    // E6 — terminar
    await page.getByTestId('invite-btn-finish-secondary').click();
    await expect(page.getByTestId('invite-finish-dialog')).toBeVisible();
    await shot(page, 'E6-terminar');
  });

  test('13-E7 serviço sem coordenada', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await gotoVacancy(page, seed.vacancyB.vacancyId);
    await page.getByTestId(ENTRY).click();
    await expect(page.getByTestId('invite-special-case')).toHaveAttribute('data-kind', 'no-service', { timeout: 30_000 });
    await shot(page, 'E7-sin-coordenada');
  });

  test('13-E8 ninguém até 50 km', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089 Visual');
    await gotoVacancy(page, seed.vacancyC.vacancyId);
    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await page.getByTestId('invite-step-5').click();
    await expect(page.getByTestId('invite-special-case')).toHaveAttribute('data-kind', 'nobody');
    await expect(page.getByTestId('points-map')).toHaveAttribute('data-rings', '5,10,20,50');
    await shot(page, 'E8-ninguem-ate-50-km');
  });
});
