/**
 * patient-conversation-humano.integration.e2e.ts @integration — spec 022, Bloco 2, T221.
 *
 * Régua humana (`e2e-humano-nao-e-fill`): clicar no compositor, `keyboard.type` o texto — NUNCA
 * `fill`/`evaluate`/`dispatchEvent` —, clicar em enviar, ler o texto que FICOU na lista de
 * mensagens (não a resposta do POST). O compositor é `contenteditable` (TipTap): não há
 * `inputValue()` — a leitura "o que ficou" é `textContent`/`toContainText` no próprio editor
 * (antes de enviar) e no item da lista (depois).
 *
 * Login também humano: `abac-stack-helper.loginAs` já é click + keyboard.type nos campos de
 * e-mail/senha (não usa `fill`) — molde citado pela task
 * (`admission-c-servico-contratado-humano.integration.e2e.ts`) é para o padrão de LEITURA do
 * valor que ficou na tela, replicado aqui.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-humano-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Humano ${RUN_ID}`;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

/** Clica no editor (contenteditable) como um humano, digita, e devolve o que a TELA mostra. */
async function digitarNoEditor(page: Page, texto: string): Promise<string> {
  const editor = page.getByTestId('composer-editor');
  await editor.click();
  await expect(editor).toBeFocused();
  await page.keyboard.type(texto);
  return (await editor.textContent()) ?? '';
}

test.describe('Chat interno por paciente — e2e humano (click + keyboard.type) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('mouse e teclado reais: digitar, clicar em enviar, e o texto FICA na lista', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    const handleBtn = page.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();
    await expect(page.getByTestId('patient-conversation-panel')).toBeVisible();

    // ── digitar como humano: click + keyboard.type, nunca fill ──
    const ficouNoEditor = await digitarNoEditor(page, 'msg-1 humano');
    expect(ficouNoEditor).toContain('msg-1 humano');

    // ── clicar em enviar (não `dispatchEvent`, não `evaluate`) ──
    const sendBtn = page.getByTestId('composer-send-btn');
    await sendBtn.click();

    // ── o que FICOU na lista, lido da TELA — não a resposta crua do POST ──
    const lista = page.getByTestId('conversation-panel-list');
    await expect(lista).toBeVisible({ timeout: 10_000 });
    await expect(lista).toContainText('msg-1 humano');

    // o compositor esvazia depois do envio — outra prova de que o clique real disparou o fluxo
    const editor = page.getByTestId('composer-editor');
    await expect(editor).not.toContainText('msg-1 humano');
  });
});
