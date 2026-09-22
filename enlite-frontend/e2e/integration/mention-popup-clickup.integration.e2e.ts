/**
 * mention-popup-clickup.integration.e2e.ts @integration — Rodada 2/R2-F (popup de menção estilo
 * ClickUp + presença simples). Decisão do Gabriel 22/09: avatar+bolinha de presença, primeiros 5
 * + "Mostrar todos" (scroll, sem filtro), sem o próprio usuário, ao digitar filtra.
 *
 * Feliz: `@` mostra até 5 candidatos (de 7 semeados) com avatar + linha "Mostrar todos".
 * Alternativo 1: "Mostrar todos" chama `staff-directory?limit=200`, mostra os 7 com scroll
 *   (`max-h-[240px] overflow-y-auto`), a bolinha de presença é VERDE para quem mandou heartbeat
 *   REAL (via API, sem mock) e CINZA para quem nunca mandou; ArrowUp uma vez do topo dá a VOLTA
 *   pro ÚLTIMO item da lista (wrap-around) e Enter o seleciona — prova de teclado até o fim,
 *   sem presumir ordem do backend.
 * Alternativo 2: digitar um filtro reduz a lista ao que bate — e "Mostrar todos" some (só existe
 *   na visão de topo, query vazia).
 *
 * Stack: mesma família de `mention-autocomplete-min-zero.integration.e2e.ts` (ver o docblock dele
 * para portas/env desta sessão).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff <N>".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedPlainStaff, cleanupPlainStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { ABAC_API_URL } from '../helpers/abac-stack-helper';
import { contrastRatioFromCss, readTextContrastRatio } from '../helpers/contrast-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-clickup-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E ClickUp ${RUN_ID}`;
const ONLINE_UID = `e2e-clickup-online-${RUN_ID}`;
const ONLINE_EMAIL = `${ONLINE_UID}@e2e.test`;
const GRUPO_ONLINE = `E2E ClickUp Online ${RUN_ID}`;
/** 10 staff "planos" (sem grupo) — nunca mandam heartbeat, ficam OFFLINE. Total com ONLINE = 11
 * (mais que os ~6 que cabem nos 240px do popup sem rolar, F4/design.md §1 — prova de scroll real). */
const OFFLINE_STAFF = Array.from({ length: 10 }, (_, i) => ({
  uid: `e2e-clickup-off-${RUN_ID}-${i}`,
  email: `e2e-clickup-off-${RUN_ID}-${i}@e2e.test`,
  name: `QA Staff Offline ${i}`,
}));

let patientId = '';
let groupId = '';
let groupIdOnline = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };
const ONLINE: MockUser = { uid: ONLINE_UID, email: ONLINE_EMAIL, role: 'recruiter', country: 'AR' };

async function openComposer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  const handleBtn = page.getByTestId('patient-conversation-handle-btn');
  await expect(handleBtn).toBeVisible({ timeout: 15_000 });
  await handleBtn.click();
  const panel = page.getByTestId('patient-conversation-panel');
  await expect(panel).toHaveClass(/translate-x-0/);
}

test.describe('Popup de @ estilo ClickUp — avatar+presença, top-5, Mostrar todos, filtro (Rodada 2/R2-F) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'staff_directory', 'read');

    for (const s of OFFLINE_STAFF) seedPlainStaff(s.uid, s.email, s.name);

    const seededOnline = seedStaffInGroup({ uid: ONLINE_UID, email: ONLINE_EMAIL, groupName: GRUPO_ONLINE, country: 'AR' });
    groupIdOnline = seededOnline.groupId;
    grantCell(groupIdOnline, 'own_presence', 'update');

    // Heartbeat REAL via API (sem mock) — é isto que faz `isOnline` virar `true` pra este uid.
    const res = await request.post(`${ABAC_API_URL}/api/admin/me/presence`, {
      headers: { Authorization: `Bearer ${tokenFor(ONLINE)}` },
    });
    expect(res.status()).toBe(204);
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupStaffAndGroup(ONLINE_UID, groupIdOnline);
    for (const s of OFFLINE_STAFF) cleanupPlainStaff(s.uid);
    cleanupPatientQA(patientId);
  });

  test('feliz: @ mostra até 5 candidatos com avatar, e a linha "Mostrar todos"', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });

    const items = list.locator('li[role="presentation"]:has([data-testid^="composer-mention-item-"])');
    await expect(items).toHaveCount(5);
    // cada linha tem avatar (PersonAvatar) — presença aparece nesta mesma varredura.
    for (let i = 0; i < 5; i += 1) {
      await expect(items.nth(i).locator('[data-testid="person-avatar"]')).toBeVisible();
    }
    await expect(page.getByTestId('composer-mention-show-all')).toBeVisible();

    // P1 (gate): as iniciais (2 letras) do avatar `size={24}` do popup NÃO podem transbordar o
    // círculo — medido pelo par real do browser (scrollWidth = largura do CONTEÚDO,
    // clientWidth = largura visível), nunca presumido pela classe CSS escrita.
    const firstAvatar = items.first().locator('[data-testid="person-avatar"]');
    const [scrollWidth, clientWidth] = await firstAvatar.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scrollWidth, 'iniciais do avatar do popup transbordam o círculo').toBeLessThanOrEqual(clientWidth);

    // P3 (gate): nome da linha em cor de texto primária do painel, ≥4.5:1 — medido de verdade
    // (getComputedStyle), não pela classe. `button > span` (filho DIRETO) pega só o nome — a
    // bolinha de presença também é um `<span>`, mas vive DENTRO do `div` do avatar, não filho
    // direto do botão (mesmo padrão já usado neste arquivo no teste "alternativo 1").
    const firstName = items.first().locator('button > span').last();
    const nameRatio = await readTextContrastRatio(firstName);
    expect(nameRatio).toBeGreaterThanOrEqual(4.5);

    // P3 (gate): item ativo (o 1º, foco inicial do popup) com fundo de destaque REALMENTE visível
    // — antes `bg-gray-100` (#FFF9FC) sobre o `bg-white` do popup era quase o mesmo branco.
    const activeBg = await items.first().locator('button').evaluate((el) => getComputedStyle(el).backgroundColor);
    const popupBg = await list.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(activeBg, 'fundo do item ativo igual ao do popup — destaque invisível').not.toBe(popupBg);

    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/r2-popup-top5.png',
    });
  });

  test('alternativo 1: "Mostrar todos" lista os 11 com scroll; presença verde/cinza real; ArrowUp do topo dá a volta pro último e Enter seleciona', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    const showAllBtn = page.getByTestId('composer-mention-show-all');
    await expect(showAllBtn).toBeVisible({ timeout: 10_000 });
    await showAllBtn.click();

    const list = page.getByTestId('composer-mention-list');
    const items = list.locator('li[role="presentation"]:has([data-testid^="composer-mention-item-"])');
    await expect(items).toHaveCount(11);
    await expect(showAllBtn).not.toBeVisible();

    // scroll real: a lista tem teto de altura (240px) — 6 linhas de avatar+nome não cabem sem rolar.
    const scrollHeight = await list.evaluate((el) => el.scrollHeight);
    const clientHeight = await list.evaluate((el) => el.clientHeight);
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/r2-popup-mostrar-todos.png',
    });

    // presença REAL: o item do staff ONLINE tem bolinha verde; qualquer OFFLINE tem cinza.
    const onlineItem = page.getByTestId(`composer-mention-item-${ONLINE_UID}`);
    const onlineDot = onlineItem.locator('[data-testid="presence-dot"]');
    await expect(onlineDot).toHaveClass(/bg-green-600/);
    const offlineItem = page.getByTestId(`composer-mention-item-${OFFLINE_STAFF[0].uid}`);
    const offlineDot = offlineItem.locator('[data-testid="presence-dot"]');
    await expect(offlineDot).toHaveClass(/bg-gray-800/);

    // P2 (gate): contraste NÃO-TEXTUAL real (WCAG 1.4.11, ≥3:1) das duas bolinhas contra a borda
    // branca (`border-white`) que as separa do avatar — medido pela mesma fórmula de
    // `contrast-helper.ts`, contra branco real (não a classe escrita).
    const onlineDotColor = await onlineDot.evaluate((el) => getComputedStyle(el).backgroundColor);
    const offlineDotColor = await offlineDot.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(contrastRatioFromCss(onlineDotColor, 'rgb(255, 255, 255)')).toBeGreaterThanOrEqual(3);
    expect(contrastRatioFromCss(offlineDotColor, 'rgb(255, 255, 255)')).toBeGreaterThanOrEqual(3);

    // teclado até o FIM, sem presumir ordem do backend: lê o ÚLTIMO item real da lista.
    const lastItem = items.last();
    const lastTestId = (await lastItem.locator('button').getAttribute('data-testid'))!;
    const lastUid = lastTestId.replace('composer-mention-item-', '');
    // `button > span` (filho DIRETO): pega só o nome (o span do `Text`) — a bolinha de presença
    // também é um `<span>`, mas vive DENTRO do `div` do avatar, não filho direto do botão.
    const lastName = (await lastItem.locator('button > span').last().textContent())!.trim();

    await editor.click(); // o clique em "Mostrar todos" não deve ter tirado o foco do editor
    await page.keyboard.press('ArrowUp'); // do topo (índice 0), dá a volta pro ÚLTIMO (wrap-around)
    await expect(lastItem.locator('button')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('composer-mention-chip')).toHaveText(`@${lastName}`);
    await expect(list).not.toBeVisible();
    void lastUid; // só para o linter — usado na leitura do testid acima
  });

  test('alternativo 2: digitar um filtro reduz a lista ao que bate, e "Mostrar todos" some', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');
    await expect(page.getByTestId('composer-mention-show-all')).toBeVisible({ timeout: 10_000 });

    // Palavra ÚNICA (sem espaço) — o `Suggestion` do TipTap fecha o popup se a query tiver
    // espaço (`allowSpaces` não ligado, decisão de design existente, fora deste conserto).
    await page.keyboard.type('Offline');
    const firstMatch = page.getByTestId(`composer-mention-item-${OFFLINE_STAFF[0].uid}`);
    await expect(firstMatch).toBeVisible({ timeout: 10_000 });
    // Filtrou: só os "Offline" batem (exclui a AUTORA e o staff ONLINE) — cortado em 5
    // (MENTION_MAX_RESULTS, a visão de topo mesmo filtrada), nunca a linha "Mostrar todos" (só
    // existe na visão de topo, QUERY VAZIA).
    await expect(page.getByTestId('composer-mention-list').locator('li')).toHaveCount(5);
    await expect(page.getByTestId('composer-mention-show-all')).not.toBeVisible();
  });
});
