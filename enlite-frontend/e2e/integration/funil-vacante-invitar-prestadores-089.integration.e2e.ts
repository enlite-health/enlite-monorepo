/**
 * funil-vacante-invitar-prestadores-089.integration.e2e.ts @integration
 *
 * E2E DE TELA da página "Invitar prestadores" (spec 089 §9.8, casos 1-12; CA-7, CA-10, CA-11, CA-13).
 * API real + Postgres real, login `loginComoStaffMock`, seed do canvas por SQL (`invitar-prestadores-089-helper.ts`),
 * clique humano (`click`/`hover`/`keyboard`/`toBeFocused`), sem preencher campo por atalho, sem script na página e sem interceptar resposta de dado.
 *
 * REGRA SUPREMA: nenhum canal real. Todo prestador nasce com `messaging_channel='periskope'`; o backend envia ao stub da
 * porta 9911 (`startPeriskopeStub`), que GRAVA cada POST. Prova DUPLA de envio: o stub recebeu E `messaged_at` está no banco.
 * Contagem de requests = `page.on('request')` (observação, nunca interceptação).
 *
 * Mapa Google: o status (`data-map-status`) é lido da tela e anotado; com `ready` o caso 4 também clica no pino real
 * (achado por `title`); com `unavailable` vale só o contrato DOM (`data-*`, ⚑12).
 *
 * Caso 12 (permissão) precisa do engine ABAC LIGADO; com o engine desligado (job padrão do CI) ele PULA com motivo.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { loginAs, seedStaffInGroup, grantCell, cleanupStaffAndGroup, meAuthz, type MockUser } from '../helpers/abac-stack-helper';
import {
  seedInvitar089,
  startPeriskopeStub,
  seedCooldownDispatch,
  inviteViaApi,
  countMessagedAt,
  readMessagedAt,
  stubSendCount,
  stubRecipients,
  chatIdOfWorker,
  SERVICE_LAT,
  SERVICE_LNG,
  type Invitar089Seed,
  type InvitarWorker,
  type PeriskopeStub,
} from '../helpers/invitar-prestadores-089-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-invitar-089',
  email: 'staff.invitar.089@e2e.test',
  role: 'admin',
  country: 'AR',
};

const ENTRY = 'invite-entry-button';
const PAGE = 'invite-page';

// ── Observação de requests (page.on('request'): só olha, nunca intercepta) ───────────────────────

interface Watch {
  posts: string[];
  gets: string[];
  sends: Array<{ workerId: string; resend: boolean }>;
  dataRequests: string[];
}

function watch(page: Page, vacancyId: string): Watch {
  const w: Watch = { posts: [], gets: [], sends: [], dataRequests: [] };
  const matchPost = new RegExp(`/vacancies/${vacancyId}/match(\\?|$)`);
  const matchGet = new RegExp(`/vacancies/${vacancyId}/match-results(\\?|$)`);
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() === 'POST' && matchPost.test(url)) w.posts.push(url);
    if (req.method() === 'GET' && matchGet.test(url)) w.gets.push(url);
    if (req.method() === 'POST' && /\/messaging\/whatsapp\/vacancy-match(\?|$)/.test(url)) {
      const body = JSON.parse(req.postData() ?? '{}') as { workerId: string; resend?: boolean };
      w.sends.push({ workerId: body.workerId, resend: body.resend === true });
    }
    if (url.includes(`/vacancies/${vacancyId}`) && url.includes('/api/')) w.dataRequests.push(`${req.method()} ${url}`);
  });
  return w;
}

// ── Gestos humanos ───────────────────────────────────────────────────────────────────────────────

/** `Checkbox` do app esconde o input (`sr-only`): o clique humano é no rótulo/caixa que o envolve. */
async function tick(page: Page, testId: string): Promise<void> {
  await page.locator('label').filter({ has: page.getByTestId(testId) }).click();
}

const rowOf = (page: Page, w: InvitarWorker) => page.getByTestId(`invite-row-${w.workerId}`);
const rowCheck = (page: Page, w: InvitarWorker) => page.getByTestId(`invite-row-check-${w.workerId}`);

async function toggleRow(page: Page, w: InvitarWorker): Promise<void> {
  await tick(page, `invite-row-check-${w.workerId}`);
}

async function stepIs(page: Page, step: string): Promise<void> {
  await expect(page.getByTestId(PAGE)).toHaveAttribute('data-step', step, { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`paso=${step}(&|$)`));
}

/** Aguarda a página carregar (F1 some, lista pronta) e devolve o passo de abertura. */
async function waitReady(page: Page): Promise<void> {
  await expect(page.getByTestId('invite-rows')).toBeVisible({ timeout: 60_000 });
}

async function gotoVacancy(page: Page, vacancyId: string): Promise<void> {
  await page.goto(`/admin/vacancies/${vacancyId}?tab=encuadres`);
  await expect(page.getByTestId(ENTRY)).toBeVisible({ timeout: 30_000 });
}

async function openInvite(page: Page, vacancyId: string): Promise<void> {
  await gotoVacancy(page, vacancyId);
  await page.getByTestId(ENTRY).click();
  await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/match`));
  await waitReady(page);
}

async function names(page: Page): Promise<string[]> {
  return page.getByTestId('invite-rows').locator('[data-testid^="invite-row-name-"]').allInnerTexts();
}

const counter = (page: Page) => page.getByTestId('invite-counter');
const footerBtn = (page: Page) => page.getByTestId('invite-btn-invite');

/** Confirma o envio pelo diálogo e espera a fila acabar (alerta F4 com o desfecho do passo). */
async function confirmAndWaitSent(page: Page): Promise<void> {
  await footerBtn(page).click();
  await expect(page.getByTestId('invite-confirm-dialog')).toBeVisible();
  await page.getByTestId('invite-confirm-send').click();
  await expect(page.getByTestId('invite-confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('invite-sent-alert')).toBeVisible({ timeout: 60_000 });
  // fila vazia: nenhuma linha "Enviando…" e o GET pós-envio já voltou
  await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });
}

async function mapStatus(page: Page): Promise<string> {
  const map = page.getByTestId('points-map');
  await expect(map).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await map.getAttribute('data-map-status')) ?? 'loading', { timeout: 30_000, message: 'status do mapa' })
    .not.toBe('loading');
  return (await map.getAttribute('data-map-status')) ?? 'unavailable';
}

function annotateMap(testInfo: TestInfo, status: string): void {
  testInfo.annotations.push({ type: 'mapa Google', description: status });
}

// ── Suíte ────────────────────────────────────────────────────────────────────────────────────────

// `E2E_089_VIDEO=1` grava vídeo (evidência local; no CI fica desligado).
test.use({ video: process.env.E2E_089_VIDEO ? 'on' : 'off' });

test.describe('funil da vacante — Invitar prestadores, pela borda (089 T043) @integration', () => {
  // Viewport 1920×1080: com a barra lateral aberta, a 1440 a coluna da lista fica estreita e o link "Ver perfil" cobre o nome.
  test.use({
    viewport: { width: 1920, height: 1080 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(180_000);
  test.describe.configure({ mode: 'default' });

  let stub: PeriskopeStub;
  let seed: Invitar089Seed;

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Invitar 089');
    stub = startPeriskopeStub();
  });
  test.afterAll(() => {
    stub.server.close();
    cleanupMockStaff(MOCK_STAFF);
  });
  // Seed por teste: o POST do match e o envio mudam o banco (INVITED/system, messaged_at) — cada caso parte do zero.
  test.beforeEach(() => {
    seed = seedInvitar089();
  });
  test.afterEach(() => {
    seed.cleanup();
  });

  const idA = (): string => seed.vacancyA.vacancyId;
  const inBand = (b: number): InvitarWorker[] => seed.candidates.filter((c) => c.band === b);
  const isPre = (c: InvitarWorker): boolean => seed.preInvited.some((p) => p.workerId === c.workerId);
  /** Pendentes (por invitar) do anel `b`: o anel menos os de 03/11; o anel 20-50 inclui o "Vacante 01" (23,4 km, manual). */
  const pendingBand = (b: number): InvitarWorker[] => [...inBand(b), ...(b === 3 ? [seed.pending[0]] : [])].filter((c) => !isPre(c));

  // 1 ───────────────────────────────────────────────────────────────────────────────────────────
  test('1 abrir pela vacante: URL, F1, passo vacante e 1 POST (CA-7)', async ({ page }) => {
    const w = watch(page, idA());
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await gotoVacancy(page, idA());
    // contador do botão = pendentes manuais (3); o GET dele é da página da vacante, anterior ao clique
    await expect(page.getByTestId('invite-entry-count')).toHaveText(String(seed.pending.length));
    const getsAntes = w.gets.length;
    const postsAntes = w.posts.length;

    await page.getByTestId(ENTRY).click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${idA()}/match`));
    // F1: carregando (mapa e lista em esqueleto) antes da lista
    await expect(page.getByTestId('invite-loading-status')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('invite-list-skeleton')).toBeVisible();
    // depois, o passo "Ya en la vacante" (2 sem WhatsApp: o de 23,4 km está no resultado do match)
    await waitReady(page);
    await stepIs(page, 'vacante');
    await expect(page.getByTestId('invite-guide')).toContainText('Estas personas ya están en la vacante');
    expect(await names(page)).toEqual(['Prestadora QA Vacante 02', 'Prestadora QA Vacante 03']);
    await expect(page.getByTestId('invite-title')).toHaveText('Invitar prestadores');

    const mapa = await mapStatus(page);
    annotateMap(test.info(), mapa);
    const posts = w.posts.length - postsAntes;
    const gets = w.gets.length - getsAntes;
    test.info().annotations.push({ type: 'requests caso 1', description: `POST ${posts} · GET ${gets} (meta + lista)` });
    console.log(`[089 caso 1] POST match=${posts} · GET match-results=${gets} · mapa=${mapa}`);
    expect(posts, 'POST …/match').toBe(1);
    expect(gets, 'GET …/match-results (meta limit=0 + lista)').toBe(2);
  });

  // 2 ───────────────────────────────────────────────────────────────────────────────────────────
  test('2 enviar "Ya en la vacante" e seguir para "Buscar cerca del servicio"', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await stepIs(page, 'vacante');
    const [v02, v03] = [seed.pending[1], seed.pending[2]];
    const callsBefore = stub.calls.length;
    const messagedBefore = countMessagedAt(idA());
    expect(readMessagedAt(v02.workerId, idA())).toBeNull();

    await expect(counter(page)).toHaveText('2 de 2 elegidos');
    await expect(footerBtn(page)).toHaveText('Invitar a 2 personas');
    await footerBtn(page).click();
    // F3: confirmação com nomes; nada sai antes do clique
    const dialog = page.getByTestId('invite-confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('invite-confirm-lead')).toHaveText('Le vamos a mandar la vacante por WhatsApp a estas 2 personas:');
    await expect(page.getByTestId(`invite-confirm-item-${v02.workerId}`)).toContainText('Prestadora QA Vacante 02');
    await expect(page.getByTestId(`invite-confirm-item-${v03.workerId}`)).toContainText('Sin ubicación');
    expect(stubSendCount(stub, callsBefore), 'nada saiu antes de confirmar').toBe(0);
    await page.getByTestId('invite-confirm-send').click();
    await expect(page.getByTestId('invite-sent-alert')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('invite-sent-alert')).toContainText('Listo: invitaste a 2 personas');
    await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });

    // prova dupla: stub recebeu exatamente os 2 confirmados E messaged_at no banco
    expect(stubSendCount(stub, callsBefore)).toBe(2);
    expect([...stubRecipients(stub, callsBefore)].sort()).toEqual([chatIdOfWorker(v02.workerId), chatIdOfWorker(v03.workerId)].sort());
    expect(readMessagedAt(v02.workerId, idA())).not.toBeNull();
    expect(readMessagedAt(v03.workerId, idA())).not.toBeNull();
    expect(countMessagedAt(idA())).toBe(messagedBefore + 2);
    // na tela (após o GET pós-envio): "Ya en la vacante" só lista quem ainda NÃO recebeu → esvazia; o cartão conta 2 invitados
    await expect(rowOf(page, v02)).toHaveCount(0);
    await expect(counter(page)).toHaveText('Todos ya invitados');
    await expect(page.getByTestId('invite-step-vacante')).toContainText('2 invitados');
    await expect(page.getByTestId('invite-invited-total')).toHaveText(`Invitados en esta vacante: ${messagedBefore + 2}`);

    await expect(page.getByTestId('invite-footer')).toHaveAttribute('data-mode', 'after');
    const more = page.getByTestId('invite-btn-more-primary');
    await expect(more).toHaveText(/Buscar cerca del servicio · hasta 5 km \(4\)/);
    await more.click();
    await stepIs(page, '5');
  });

  // 3 ───────────────────────────────────────────────────────────────────────────────────────────
  test('3 anel 5 km: contagens, pré-seleção, desmarcar 1 por clique e "Todos"', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');

    const band = inBand(0); // 6 pessoas, 2 já convidadas em 03/11
    const pend = pendingBand(0); // 4
    expect(band.length).toBe(6);
    expect(pend.length).toBe(4);
    // cartões de passo
    await expect(page.getByTestId('invite-step-5')).toContainText('4 por invitar');
    await expect(page.getByTestId('invite-step-10')).toContainText('8 por invitar');
    await expect(page.getByTestId('invite-step-20')).toContainText('11 por invitar');
    await expect(page.getByTestId('invite-step-50')).toContainText('10 por invitar');
    // lista: 6 linhas; os 2 convidados em 03/11 sem caixa e com selo; 4 pré-selecionados
    expect((await names(page)).length).toBe(6);
    await expect(page.getByTestId('invite-list-title')).toHaveText('Hasta 5 km del servicio');
    await expect(counter(page)).toHaveText('4 de 4 elegidos');
    await expect(footerBtn(page)).toHaveText('Invitar a 4 personas');
    for (const c of seed.preInvited.filter((p) => p.band === 0)) {
      await expect(rowOf(page, c)).toBeVisible();
      await expect(rowCheck(page, c)).toHaveCount(0);
      await expect(page.getByTestId(`invite-row-badge-${c.workerId}`)).toHaveText('Invitado el 03/11');
    }
    for (const c of pend) await expect(rowCheck(page, c)).toBeChecked();
    await expect(page.locator('[data-testid^="invite-row-"][data-selected="true"]')).toHaveCount(4);

    // desmarcar 1 por clique
    await toggleRow(page, pend[0]);
    await expect(rowCheck(page, pend[0])).not.toBeChecked();
    await expect(counter(page)).toHaveText('3 de 4 elegidos');
    await expect(footerBtn(page)).toHaveText('Invitar a 3 personas');
    // "Todos" re-seleciona os 4; de novo, zera
    await tick(page, 'invite-select-all');
    await expect(counter(page)).toHaveText('4 de 4 elegidos');
    await expect(page.getByTestId('invite-select-all')).toBeChecked();
    await tick(page, 'invite-select-all');
    await expect(counter(page)).toHaveText('0 de 4 elegidos');
    await expect(page.getByTestId('invite-footer')).toHaveAttribute('data-mode', 'empty');
    await expect(footerBtn(page)).toBeDisabled();
    await expect(page.getByTestId('invite-footer-hint')).toHaveText('Elegí al menos una persona');
  });

  // 4 ───────────────────────────────────────────────────────────────────────────────────────────
  test('4 pino e lista: contrato DOM, hover/clique na linha e pino real quando o mapa está ready', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const status = await mapStatus(page);
    annotateMap(test.info(), status);
    console.log(`[089 caso 4] mapa Google: ${status}`);
    const map = page.getByTestId('points-map');
    const band = inBand(0);

    // contrato DOM (sempre presente)
    await expect(map).toHaveAttribute('data-rings', '5');
    await expect(map).toHaveAttribute('data-fit-radius-km', '5');
    await expect(map).toHaveAttribute('data-center', `${SERVICE_LAT},${SERVICE_LNG}`);
    await expect(map).not.toHaveAttribute('data-selected-id', /.+/);
    if (status === 'ready') await expect(map).toHaveAttribute('data-markers', String(band.length));

    // hover na LINHA realça; clique no NOME foca a linha e o pino (data-selected-id); de novo, solta
    const a = band[2];
    await rowOf(page, a).hover();
    await expect(rowOf(page, a)).toHaveAttribute('data-highlighted', 'true');
    await page.getByTestId(`invite-row-name-${a.workerId}`).click();
    await expect(map).toHaveAttribute('data-selected-id', a.workerId);
    await expect(rowOf(page, a)).toHaveAttribute('data-focused', 'true');
    await page.getByTestId(`invite-row-name-${a.workerId}`).click();
    await expect(map).not.toHaveAttribute('data-selected-id', /.+/);
    await expect(rowOf(page, a)).not.toHaveAttribute('data-focused', 'true');

    // anéis crescem com o passo (contrato do mapa): 5 → 10
    await page.getByTestId('invite-step-10').click();
    await stepIs(page, '10');
    await expect(map).toHaveAttribute('data-rings', '5,10');
    await expect(map).toHaveAttribute('data-fit-radius-km', '10');

    // pino REAL (só com o mapa ready): clicar no marcador (title do pino) foca a linha correspondente
    if (status === 'ready') {
      await page.getByTestId('invite-step-5').click();
      await stepIs(page, '5');
      const b = band[3];
      await map.locator(`[title^="${b.name}, "]`).click();
      await expect(map).toHaveAttribute('data-selected-id', b.workerId);
      await expect(rowOf(page, b)).toHaveAttribute('data-focused', 'true');
      await expect(page.getByTestId(`invite-row-name-${b.workerId}`)).toBeFocused();
    } else {
      test.info().annotations.push({ type: 'pino real', description: 'pulado: mapa unavailable (só contrato DOM, ⚑12)' });
    }
  });

  // 5 ───────────────────────────────────────────────────────────────────────────────────────────
  test('5 interruptor de documentos: esconde, desmarca e as contagens acompanham', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const band = inBand(0);
    const missing = band.filter((c) => !c.docsComplete); // sem documentos completos no anel
    const complete = band.filter((c) => c.docsComplete);
    const pendComplete = pendingBand(0).filter((c) => c.docsComplete);
    expect(missing.length).toBeGreaterThan(0);

    await expect(page.getByTestId('invite-docs-line')).toHaveText(`Completos: ${complete.length} · Faltan documentos: ${missing.length}`);
    await expect(counter(page)).toHaveText('4 de 4 elegidos');
    const sw = page.getByRole('switch', { name: 'Solo con documentos completos' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    // esconde: só ficam os completos; os escondidos saem da lista, do mapa e da seleção
    expect((await names(page)).sort()).toEqual(complete.map((c) => c.name).sort());
    for (const c of missing) await expect(rowOf(page, c)).toHaveCount(0);
    await expect(page.getByTestId('invite-docs-line')).toHaveText(`Completos: ${complete.length} · Ocultos por documentos: ${missing.length}`);
    await expect(counter(page)).toHaveText(`${pendComplete.length} de ${pendComplete.length} elegidos`);
    await expect(footerBtn(page)).toHaveText(`Invitar a ${pendComplete.length} personas`);
    await expect(page.getByTestId('invite-step-5')).toContainText(`${pendComplete.length} por invitar`);
    // vale para a tela inteira: os outros cartões contam só quem tem documentos completos
    for (const [step, b] of [['10', 1], ['20', 2], ['50', 3]] as const) {
      const n = pendingBand(b).filter((c) => c.docsComplete).length;
      await expect(page.getByTestId(`invite-step-${step}`)).toContainText(`${n} por invitar`);
    }

    // desligar NÃO re-seleciona quem voltou
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect((await names(page)).length).toBe(band.length);
    await expect(counter(page)).toHaveText(`${pendComplete.length} de 4 elegidos`);
    for (const c of missing.filter((m) => !isPre(m))) await expect(rowCheck(page, c)).not.toBeChecked();
  });

  // 6 ───────────────────────────────────────────────────────────────────────────────────────────
  test('6a confirmação com já convidado, caixa desmarcada: o já convidado NÃO recebe', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    const w = watch(page, idA());
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const pend = pendingBand(0);
    const keep = pend[0];
    const pre = seed.preInvited.filter((p) => p.band === 0);
    const preBefore = pre.map((p) => readMessagedAt(p.workerId, idA()));
    // só 1 elegido (zera e marca 1)
    await tick(page, 'invite-select-all');
    await expect(counter(page)).toHaveText('0 de 4 elegidos');
    await toggleRow(page, keep);
    await expect(counter(page)).toHaveText('1 de 4 elegidos');
    const callsBefore = stub.calls.length;

    await footerBtn(page).click();
    await expect(page.getByTestId('invite-confirm-already')).toContainText('ya recibieron la invitación el 03/11');
    await expect(page.getByTestId('invite-confirm-already')).toContainText('No se la vamos a enviar de nuevo');
    await expect(page.getByTestId('invite-confirm-resend')).not.toBeChecked();
    await expect(page.getByTestId('invite-confirm-send')).toHaveText('Sí, enviar a 1 persona');
    await page.getByTestId('invite-confirm-send').click();
    await expect(page.getByTestId('invite-sent-alert')).toContainText('Listo: invitaste a 1 persona', { timeout: 60_000 });
    await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });

    expect(stubSendCount(stub, callsBefore)).toBe(1);
    expect(stubRecipients(stub, callsBefore)).toEqual([chatIdOfWorker(keep.workerId)]);
    for (const p of pre) expect(stubRecipients(stub, callsBefore)).not.toContain(chatIdOfWorker(p.workerId));
    expect(readMessagedAt(keep.workerId, idA())).not.toBeNull();
    // o já convidado segue com o messaged_at de 03/11, intocado
    expect(pre.map((p) => readMessagedAt(p.workerId, idA()))).toEqual(preBefore);
    // a fila do navegador mandou 1 POST, sem `resend`
    expect(w.sends).toEqual([{ workerId: keep.workerId, resend: false }]);
  });

  test('6b confirmação com já convidado, caixa marcada: o já convidado recebe (resend)', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    const w = watch(page, idA());
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const keep = pendingBand(0)[0];
    const pre = seed.preInvited.filter((p) => p.band === 0);
    const preBefore = pre.map((p) => readMessagedAt(p.workerId, idA()));
    await tick(page, 'invite-select-all');
    await toggleRow(page, keep);
    await expect(counter(page)).toHaveText('1 de 4 elegidos');
    const callsBefore = stub.calls.length;

    await footerBtn(page).click();
    await expect(page.getByTestId('invite-confirm-send')).toHaveText('Sí, enviar a 1 persona');
    await tick(page, 'invite-confirm-resend');
    await expect(page.getByTestId('invite-confirm-resend')).toBeChecked();
    await expect(page.getByTestId('invite-confirm-send')).toHaveText(`Sí, enviar a ${1 + pre.length} personas`);
    await page.getByTestId('invite-confirm-send').click();
    await expect(page.getByTestId('invite-sent-alert')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Enviando…')).toHaveCount(0, { timeout: 60_000 });

    expect(stubSendCount(stub, callsBefore)).toBe(1 + pre.length);
    expect([...stubRecipients(stub, callsBefore)].sort()).toEqual([keep, ...pre].map((c) => chatIdOfWorker(c.workerId)).sort());
    // o corpo que a tela mandou à API: `resend:true` só para os já convidados
    expect(w.sends.filter((s) => s.resend).map((s) => s.workerId).sort()).toEqual(pre.map((p) => p.workerId).sort());
    expect(w.sends.find((s) => s.workerId === keep.workerId)).toEqual({ workerId: keep.workerId, resend: false });
    // banco: o reenvio regravou o messaged_at dos já convidados (e o novo foi gravado)
    expect(readMessagedAt(keep.workerId, idA())).not.toBeNull();
    pre.forEach((p, i) => expect(readMessagedAt(p.workerId, idA()), `messaged_at de ${p.name} após reenvio`).not.toBe(preBefore[i]));
  });

  // 7 ───────────────────────────────────────────────────────────────────────────────────────────
  test('7 alternativo: servidor recusa (COOLDOWN) — "no se enviaron", linha sem "Invitado hoy"', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const target = pendingBand(0)[0];
    seedCooldownDispatch(target.workerId, idA(), 1); // despacho há 1 dia → guard 422 COOLDOWN (3 dias)
    await tick(page, 'invite-select-all');
    await toggleRow(page, target);
    await expect(counter(page)).toHaveText('1 de 4 elegidos');
    const callsBefore = stub.calls.length;

    await confirmAndWaitSent(page);

    const alert = page.getByTestId('invite-sent-alert');
    await expect(alert).toHaveAttribute('data-failed', '1');
    await expect(alert).toContainText('No se envió ninguna invitación');
    await expect(page.getByTestId('invite-sent-failed')).toHaveText('1 no se enviaron');
    // a linha continua NÃO convidada, com o selo de erro localizado
    const badge = page.getByTestId(`invite-row-badge-${target.workerId}`);
    await expect(badge).not.toHaveText(/Invitado/);
    await expect(badge).not.toBeEmpty();
    await expect(rowCheck(page, target)).toHaveCount(1);
    // prova dupla: o stub NÃO recebeu nada e o banco não gravou messaged_at
    expect(stubSendCount(stub, callsBefore)).toBe(0);
    expect(readMessagedAt(target.workerId, idA())).toBeNull();
  });

  // 8 ───────────────────────────────────────────────────────────────────────────────────────────
  test('8 alternativo: estado muda por fora — após o refetch a pessoa vira "Invitado" e sai da seleção', async ({ page, request }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await openInvite(page, idA());
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    const pend = pendingBand(0);
    const outside = pend[0]; // convidado por fora, com a página aberta
    const mine = pend[1];
    await tick(page, 'invite-select-all');
    await toggleRow(page, mine);
    await expect(counter(page)).toHaveText('1 de 4 elegidos');
    await expect(page.getByTestId(`invite-row-badge-${outside.workerId}`)).toBeEmpty();

    const callsBefore = stub.calls.length;
    const res = await inviteViaApi(request, MOCK_STAFF, outside.workerId, idA());
    expect(res.status).toBe(200);
    expect(stubSendCount(stub, callsBefore)).toBe(1);
    expect(readMessagedAt(outside.workerId, idA())).not.toBeNull();
    // a página ainda não sabe: a linha segue com caixa
    await expect(rowCheck(page, outside)).toHaveCount(1);

    await confirmAndWaitSent(page);
    // refetch pós-envio: quem foi convidado por fora vira "Invitado …" (hoje) e sai da seleção (sem caixa)
    await expect(page.getByTestId(`invite-row-badge-${outside.workerId}`)).toHaveText(/^Invitado (hoy|el \d{2}\/\d{2})$/);
    await expect(rowCheck(page, outside)).toHaveCount(0);
    await expect(rowCheck(page, mine)).toHaveCount(0);
    await expect(page.getByTestId(`invite-row-badge-${mine.workerId}`)).toHaveText('Invitado hoy');
    // sobraram 2 por invitar (4 − o de fora − o meu); nenhum elegido
    await expect(counter(page)).toHaveText('0 de 2 elegidos');
    // o do envio (1) + o de fora (1) = 2 mensagens no stub; nenhuma duplicada para o de fora
    expect(stubSendCount(stub, callsBefore)).toBe(2);
    expect(stubRecipients(stub, callsBefore).filter((r) => r === chatIdOfWorker(outside.workerId))).toHaveLength(1);
  });

  // 9 ───────────────────────────────────────────────────────────────────────────────────────────
  test('9 ampliar 5 → 10 → 20 → 50 sem novo POST', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    const w = watch(page, idA());
    await gotoVacancy(page, idA());
    const getsAntes = w.gets.length;
    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await page.getByTestId('invite-step-5').click();
    await stepIs(page, '5');
    expect(w.posts.length).toBe(1);
    const getsAbertura = w.gets.length - getsAntes;

    const rings: Array<[string, string]> = [['10', '5,10'], ['20', '5,10,20'], ['50', '5,10,20,50']];
    for (const [km, data] of rings) {
      await page.getByTestId('invite-btn-more-secondary').click();
      await stepIs(page, km);
      await expect(page.getByTestId('points-map')).toHaveAttribute('data-rings', data);
      await expect(page.getByTestId('points-map')).toHaveAttribute('data-fit-radius-km', km);
      await expect(page.getByTestId('invite-list-title')).toContainText(`${km === '10' ? 'Entre 5 y 10' : km === '20' ? 'Entre 10 y 20' : 'Entre 20 y 50'} km del servicio`);
    }
    // último passo: não há "más lejos"
    await expect(page.getByTestId('invite-btn-more-secondary')).toHaveCount(0);
    await expect(page.getByTestId('invite-btn-more-primary')).toHaveCount(0);
    expect(w.posts.length, 'POST …/match durante toda a ampliação').toBe(1);
    expect(w.gets.length - getsAntes, 'nenhum GET novo ao trocar de passo').toBe(getsAbertura);
  });

  // 10 ──────────────────────────────────────────────────────────────────────────────────────────
  test('10 Terminar → F5 com números do servidor → Volver à mesma aba e visão; voltar do navegador; reload mantém ?paso=', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    await gotoVacancy(page, idA());
    // sai da visão padrão (Kanban) para a Lista, para provar que volta na MESMA visão
    await page.getByRole('group', { name: 'Cambiar vista' }).getByRole('button', { name: 'Lista' }).click();
    const lista = page.getByRole('group', { name: 'Cambiar vista' }).getByRole('button', { name: 'Lista' });
    await expect(lista).toHaveAttribute('aria-pressed', 'true');
    const vacancyUrl = `/admin/vacancies/${idA()}`;

    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await stepIs(page, 'vacante');
    await confirmAndWaitSent(page); // os 2 de "Ya en la vacante"
    await page.getByTestId('invite-btn-finish-secondary').click();
    const finish = page.getByTestId('invite-finish-dialog');
    await expect(finish).toBeVisible();
    // números do SERVIDOR (convites do dia na vacante), não da sessão
    await expect(page.getByTestId('invite-finish-title')).toHaveText('Hoy invitaste a 2 prestadores para esta vacante');
    await expect(page.getByTestId('invite-finish-row-vacante')).toContainText('2');
    await page.getByTestId('invite-finish-back').click();
    await expect(page).toHaveURL(new RegExp(`${vacancyUrl}\\?(.*&)?tab=encuadres`));
    await expect(lista).toHaveAttribute('aria-pressed', 'true');

    // voltar do navegador dá o mesmo resultado (entra de novo e volta pelo botão do navegador)
    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${vacancyUrl}\\?(.*&)?tab=encuadres`));
    await expect(lista).toHaveAttribute('aria-pressed', 'true');

    // recarregar mantém o passo da URL
    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await page.getByTestId('invite-step-10').click();
    await stepIs(page, '10');
    await page.reload();
    await waitReady(page);
    await stepIs(page, '10');
    await expect(page).toHaveURL(/paso=10/);

    // entrada direta (sem histórico da vacante): "Volver" cai na vacante, aba encuadres
    const url = new URL(page.url());
    await page.goto(`${url.pathname}`);
    await waitReady(page);
    await page.getByTestId('invite-back').click();
    await expect(page).toHaveURL(new RegExp(`${vacancyUrl}\\?(.*&)?tab=encuadres`));
  });

  // 11 ──────────────────────────────────────────────────────────────────────────────────────────
  test('11a F6: serviço sem coordenada — 0 POST, endereço cru e "Corregir la dirección"', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    const idB = seed.vacancyB.vacancyId;
    const w = watch(page, idB);
    await gotoVacancy(page, idB);
    await page.getByTestId(ENTRY).click();
    const special = page.getByTestId('invite-special-case');
    await expect(special).toBeVisible({ timeout: 30_000 });
    await expect(special).toHaveAttribute('data-kind', 'no-service');
    await expect(page.getByText('No sabemos dónde es el servicio')).toBeVisible();
    await expect(page.getByTestId('invite-no-service-address')).toContainText('Calle Sin Coordenada 100, QA');
    expect(w.posts.length, 'POST …/match sem coordenada').toBe(0);
    await expect(page.getByTestId('points-map')).toHaveCount(0);
    // corregir leva ao itinerário do paciente
    await page.getByTestId('invite-special-fix').click();
    await expect(page).toHaveURL(new RegExp(`/admin/patients/${seed.vacancyB.patientId}\\?tab=itinerary`));
    expect(w.posts.length).toBe(0);
  });

  test('11b F6: ninguém até 50 km — 1 POST, anéis e "Ver las N" leva ao passo vacante', async ({ page }) => {
    await loginComoStaffMock(page, MOCK_STAFF, 'E2E Invitar 089');
    const idC = seed.vacancyC.vacancyId;
    const w = watch(page, idC);
    const pendingC = seed.vacancyC.pendingNoArea;
    await gotoVacancy(page, idC);
    await page.getByTestId(ENTRY).click();
    await waitReady(page);
    await stepIs(page, 'vacante'); // há pendentes: abre em "Ya en la vacante"
    expect((await names(page)).sort()).toEqual(pendingC.map((c) => c.name).sort());
    // vai para um passo de distância: ninguém → cartão sobre o mapa com os 4 anéis
    await page.getByTestId('invite-step-5').click();
    const nobody = page.getByTestId('invite-special-case');
    await expect(nobody).toHaveAttribute('data-kind', 'nobody');
    await expect(page.getByText('No encontramos prestadores hasta 50 km')).toBeVisible();
    await expect(page.getByTestId('points-map')).toHaveAttribute('data-rings', '5,10,20,50');
    await expect(page.getByTestId('invite-nobody-vacante')).toContainText(`Hay ${pendingC.length} personas en la vacante que todavía no recibieron el WhatsApp.`);
    await page.getByTestId('invite-nobody-see').click();
    await stepIs(page, 'vacante');
    expect((await names(page)).length).toBe(pendingC.length);
    await expect(page.getByTestId('invite-special-case')).toHaveCount(0);
    expect(w.posts.length, 'o POST roda uma vez, sem raio vazio gravar nada').toBe(1);
  });

  // 12 ──────────────────────────────────────────────────────────────────────────────────────────
  test('12 permissão negada (sem messaging:send e match:read): sem botão; rota direta = "Sin permiso", 0 request de dado', async ({ page, request }) => {
    // Só mede com o engine ABAC LIGADO (`enforcement:on`); no job padrão do CI ele está OFF e a API do ABAC nem existe.
    const probe: MockUser = { uid: 'e2e-int-probe-invitar-089', email: 'probe.invitar.089@e2e.test', role: 'recruiter', country: 'AR' };
    const enforcement = await meAuthz(request, probe).then((r) => (r.body as { enforcement?: string } | null)?.enforcement ?? 'unknown', () => 'unreachable');
    test.skip(enforcement !== 'on', `engine ABAC não está ligado (enforcement=${enforcement}): roda no job group-simulation ou com ABAC_API_URL/ABAC_TEST_DB_URL/PW_BASE_URL apontando para um stack com o engine ligado`);

    const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const user: MockUser = { uid: `e2e-v089-sem-${run}`, email: `e2e-v089-sem-${run}@e2e.test`, role: 'recruiter', country: 'AR' };
    const { groupId } = seedStaffInGroup({ uid: user.uid, email: user.email, groupName: `E2E Invitar089 sem celula ${run}`, country: 'AR' });
    try {
      grantCell(groupId, 'vacancy', 'read'); // vê a vacante; NÃO tem match:read nem messaging:send
      const w = watch(page, idA());
      await loginAs(page, user);
      await page.goto(`/admin/vacancies/${idA()}?tab=encuadres`);
      await expect(page.getByTestId('invite-entry')).toHaveCount(0);
      await expect(page.getByTestId(ENTRY)).toHaveCount(0);

      // sai da vacante (a página dela faz polling) para uma tela neutra; depois mede só a rota direta
      await page.goto('/admin/dashboard');
      await expect(page).toHaveURL(/\/admin\/dashboard/);
      // rota direta: "Sin permiso" e NENHUMA request de dado da vacante (nem a da vacante, nem match, nem match-results)
      const antes = w.dataRequests.length;
      await page.goto(`/admin/vacancies/${idA()}/match`);
      const msg = page.getByTestId('invite-no-permission');
      await expect(msg).toBeVisible({ timeout: 30_000 });
      await expect(msg).toContainText('Sin permiso');
      await expect(page.getByTestId('invite-rows')).toHaveCount(0);
      await expect(page.getByTestId('points-map')).toHaveCount(0);
      expect(w.dataRequests.slice(antes), 'requests de dado da vacante na rota negada').toEqual([]);
      expect(w.posts.length, 'POST …/match').toBe(0);
    } finally {
      cleanupStaffAndGroup(user.uid, groupId);
    }
  });
});
