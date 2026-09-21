/**
 * patient-conversation-discard.integration.e2e.ts @integration — spec 022, Bloco 2, T220.
 *
 * Alternativo 2: escrever no compositor, tentar fechar o painel, confirmar o diálogo de
 * descarte, cancelar mantém o painel aberto com o texto intacto.
 *
 * Ficou RED (achado alto, `evidencias/achados.md`) até o conserto de `evidencias/b2-conserto-descarte.md`:
 * `useConfirmDiscardClose`/`requestClose` do `MessageComposer` (T215/T216) só era exercitado nos
 * testes UNITÁRIOS via `ref.current.requestClose()` direto — nenhum caller de produção chamava.
 * Esc fechava o painel chamando `onClose` DIRETO (`SlideOverPanel.tsx`), sem perguntar nada, e
 * não havia botão "X" no painel. O conserto deu ao `SlideOverPanel` um `onRequestClose`
 * (Esc + botão X, os dois centralizados) que o `PatientConversationHandle` liga ao
 * `MessageComposerHandle.requestClose()` do composer ATIVO — agora os dois caminhos passam pelo
 * gate de descarte antes de fechar de verdade.
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-descarte-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Descarte ${RUN_ID}`;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Chat interno por paciente — rascunho não enviado (alternativo 2) @integration', () => {
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

  test('rascunho não vazio: fechar pede confirmação; cancelar preserva painel e texto', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 rascunho');
    await expect(editor).toContainText('msg-1 rascunho');

    // Esc é um dos dois caminhos de fechar (o outro é o botão X do SlideOverPanel) — os dois
    // passam pelo mesmo gate de descarte (ver docblock).
    await page.keyboard.press('Escape');

    const confirmDialog = page.getByTestId('composer-discard-confirm');
    await expect(confirmDialog).toBeVisible({ timeout: 3_000 });
    // Idioma padrão do produto é es-AR (CLAUDE.md do frontend) — o texto real renderizado é o de
    // `es.json` (`composer.discardConfirm`), não o de `pt-BR.json` que o teste tinha antes.
    await expect(confirmDialog).toContainText('¿Descartar el mensaje sin enviar?');

    // "Cancelar" — mantém o painel aberto, texto intacto.
    await page.getByTestId('composer-discard-cancel').click();
    await expect(confirmDialog).not.toBeVisible();
    await expect(panel).toBeVisible();
    await expect(editor).toContainText('msg-1 rascunho');
  });
});
