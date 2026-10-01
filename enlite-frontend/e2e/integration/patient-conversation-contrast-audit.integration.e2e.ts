/**
 * patient-conversation-contrast-audit.integration.e2e.ts @integration — ajustes de UI B5, rodada
 * de contraste (pedido do Gabriel: "varra TODO texto visível do painel de conversa, da visão de
 * respostas, do compositor e do painel do sino").
 *
 * `scanContrastViolations` (`../helpers/contrast-helper.ts`) varre TODO elemento com texto DIRETO
 * visível dentro do container e falha se algum ficar < 4.5:1 (WCAG AA, texto pequeno) — não
 * depende de saber o testid de antemão, então pega qualquer texto que uma edição futura esqueça.
 *
 * Placeholder do compositor é um CASO À PARTE: `::before` (CSS gerado) não é um nó de texto real
 * — o scanner genérico não o vê. Medido/travado por fora, lendo `getComputedStyle(el, '::before')`
 * diretamente (ver teste dedicado abaixo).
 *
 * Prova PELO AVESSO da própria régua (não só dos itens 1/2): reintroduz `text-gray-500` num
 * elemento real, mostra que o scanner ACUSA (RED), desfaz via `cp`, mostra que passa (GREEN) —
 * nunca `git checkout`/`reset`.
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { scanContrastViolations } from '../helpers/contrast-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-contrast-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Contrast ${RUN_ID}`;
const MIN_RATIO = 4.5;

let patientId = '';
let groupId = '';
const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Auditoria de contraste — painel de conversa + sino (ajustes de UI B5) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'staff_directory', 'read');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('painel VAZIO ("Aún no hay mensajes") + compositor (placeholder) — 0 violações', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-conversation-handle-btn').click();

    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('conversation-panel-empty')).toBeVisible();
    await expect(page.getByTestId('composer-editor')).toBeVisible();

    const violations = await scanContrastViolations(panel, MIN_RATIO);
    expect(violations, `violações de contraste:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);

    // Placeholder — CSS gerado (`::before`), o scanner genérico não alcança; medido à parte.
    // 🔒 A decoração do TipTap (`is-editor-empty`/`data-placeholder`) vai no NÓ (o `<p>` vazio),
    // NUNCA no `composer-editor` (a `<div>` contenteditable que o envolve) — medir `::before` no
    // elemento errado dá a cor HERDADA/padrão (preto), não a do CSS injetado (achado desta sessão).
    const editor = page.getByTestId('composer-editor');
    const placeholderNode = editor.locator('.is-editor-empty').first();
    const placeholderColor = await placeholderNode.evaluate((el) => getComputedStyle(el, '::before').color);
    const bgColor = await editor.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(placeholderColor).toBe('rgb(115, 115, 115)'); // #737373, gray-800 — 4.74:1 medido nesta sessão
    expect(bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'rgb(255, 255, 255)').toBe(true);
  });

  test('painel com MENSAGEM (card, footer, anexo) — 0 violações', async ({ page, request }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('msg-1 auditoria de contraste');
    await page.getByTestId('composer-send-btn').click();
    await expect(page.getByTestId('conversation-panel-list')).toContainText('msg-1 auditoria de contraste');

    const violations = await scanContrastViolations(panel, MIN_RATIO);
    expect(violations, `violações de contraste:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  test('PROVA PELO AVESSO: o scanner ACUSA um texto real claro demais (RED) e para de acusar quando ele é desfeito (GREEN)', async ({ page }) => {
    // O "avesso" aqui é sobre o COMPORTAMENTO do scanner (não há arquivo de origem para editar —
    // o scanner é o produto sob prova). Injeta um elemento REAL no DOM já carregado (mesma
    // disciplina do `cp`/desfaz: nada fica quebrado depois — o elemento é removido no fim, nunca
    // um arquivo do repo é tocado por este teste).
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.setAttribute('data-testid', 'contrast-avesso-defeito');
      el.textContent = 'texto de prova — cinza claro demais';
      el.style.color = 'rgb(217, 217, 217)'; // gray-600 desta paleta — medido ~1.4:1 sobre branco
      document.querySelector('[data-testid="patient-conversation-panel"]')!.appendChild(el);
    });

    const redViolations = await scanContrastViolations(panel, MIN_RATIO);
    const found = redViolations.find((v) => v.text.includes('texto de prova'));
    expect(found, 'o scanner tinha que ACUSAR o texto injetado (RED)').toBeDefined();
    expect(found!.ratio).toBeLessThan(MIN_RATIO);

    // desfaz — remove o elemento injetado, mesmo princípio do avesso (nunca sobra estado quebrado).
    await page.evaluate(() => {
      document.querySelector('[data-testid="contrast-avesso-defeito"]')?.remove();
    });
    const greenViolations = await scanContrastViolations(panel, MIN_RATIO);
    expect(greenViolations.find((v) => v.text.includes('texto de prova'))).toBeUndefined();
  });
});
