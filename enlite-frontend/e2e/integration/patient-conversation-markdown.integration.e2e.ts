/**
 * patient-conversation-markdown.integration.e2e.ts @integration — spec 072, T6.
 *
 * Markdown na mensagem do paciente, VISTO NA TELA: login real (humano — click + keyboard.type,
 * `abac-stack-helper.loginAs`), abrir o painel `Mensajes`, digitar no compositor, enviar e ler o
 * resultado no `message-body` do card. Sem preenchimento programático: prova o uso humano, não o estado.
 *   E1 feliz: negrito + lista renderizados, sem `**` literal.
 *   E2 segurança: HTML cru e `javascript:` não executam nem viram elemento/link.
 *   E3 quebra e link: Shift+Enter vira linha distinta; link externo com target/rel seguros.
 * Não menciona ninguém (sem "@"): sem fan-out de notificação.
 *
 * Stack: a mesma do `patient-conversation-happy.integration.e2e.ts` (ver o docblock dele para
 * Postgres/API/Vite e as env vars `E2E_PG_CONTAINER`, `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `PW_BASE_URL`).
 * Rodar com: npx playwright test --project=integration e2e/integration/patient-conversation-markdown.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", corpo sintético ("Teste sintético", "linha 1").
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-md-autora-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Markdown ${RUN_ID}`;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

/** Abre a ficha, o painel e confere idioma (es) e que a dica de Markdown não existe mais. */
async function abrirPainel(page: Page): Promise<void> {
  await loginAs(page, AUTORA);
  await page.goto(`/admin/patients/${patientId}`);
  const handleBtn = page.getByTestId('patient-conversation-handle-btn');
  await expect(handleBtn).toBeVisible({ timeout: 15_000 });
  await handleBtn.click();
  await expect(page.getByTestId('patient-conversation-panel')).toHaveClass(/translate-x-0/);
  await expect(page.getByTestId('conversation-panel-header')).toHaveText('Mensajes');
  await expect(page.getByTestId('composer-markdown-hint')).toHaveCount(0);
}

/** Foca o editor como um humano (click + foco conferido) e devolve o locator. */
async function focarEditor(page: Page) {
  const editor = page.getByTestId('composer-editor');
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

/** Clica em enviar e devolve o `message-body` do card criado (lido da tela). */
async function enviar(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
  await page.getByTestId('composer-send-btn').click();
  const body = (await (await posted).json()) as { data: { id: string } };
  expect(body.data.id).toBeTruthy();
  const card = page.getByTestId(`conversation-message-${body.data.id}`);
  await expect(card).toBeVisible();
  return card.getByTestId('message-body');
}

test.use({ video: 'on' });

test.describe('Chat interno por paciente — markdown na mensagem (spec 072) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'patient_conversation', 'update');
    grantCell(groupId, 'patient_conversation', 'delete');
    grantCell(groupId, 'staff_directory', 'read');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
    safeSql(`DELETE FROM conversation_read_marks WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_id = '${patientId}')`);
  });

  test('E1 feliz — negrito e lista renderizados no card, sem ** literal', async ({ page }) => {
    await abrirPainel(page);
    await focarEditor(page);
    await page.keyboard.type('**Teste** sintético');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- um');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- dois');
    await expect(page.getByTestId('composer-counter')).toBeVisible();

    const body = await enviar(page);
    await expect(body.locator('strong')).toHaveText('Teste');
    await expect(body.locator('ul > li')).toHaveCount(2);
    await expect(body.locator('ul > li').nth(0)).toHaveText('um');
    await expect(body.locator('ul > li').nth(1)).toHaveText('dois');
    expect(await body.textContent()).not.toContain('**');
    await expect(body).toContainText('sintético');
  });

  test('E2 alternativo (segurança) — HTML cru e javascript: ficam inertes', async ({ page }) => {
    await abrirPainel(page);
    await focarEditor(page);
    await page.keyboard.type('<img src=x onerror="window.__pwn=1">');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[x](javascript:window.__pwn=1)');

    const body = await enviar(page);
    await expect(body.locator('img')).toHaveCount(0);
    await expect(body.locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(body).toContainText('<img');
    // dá tempo de um onerror (se existisse) disparar antes de ler a flag
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => (window as unknown as { __pwn?: unknown }).__pwn)).toBeUndefined();
  });

  test('E3 alternativo (quebra e link) — linhas distintas e link externo seguro', async ({ page }) => {
    await abrirPainel(page);
    await focarEditor(page);
    await page.keyboard.type('linha 1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('linha 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[doc](https://exemplo.test/p)');

    const body = await enviar(page);
    const primeiroP = body.locator('p').first();
    await expect(primeiroP).toContainText('linha 1');
    await expect(primeiroP).toContainText('linha 2');
    expect(await primeiroP.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    // as duas linhas ocupam linhas visuais distintas (altura > 1 linha)
    const alturas = await primeiroP.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(alturas.h).toBeGreaterThan(alturas.lh * 1.5);

    const link = body.locator('a[href="https://exemplo.test/p"][target="_blank"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('rel', /noopener/);
  });
});
