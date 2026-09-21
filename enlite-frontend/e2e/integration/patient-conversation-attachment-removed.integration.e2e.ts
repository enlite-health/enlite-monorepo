/**
 * patient-conversation-attachment-removed.integration.e2e.ts @integration — spec 022, Bloco 3
 * (2º alternativo de tela para anexo, conserto do gate revisao-pr B3, achado "Critério 4").
 *
 * Comportamento REAL de usuário: anexar um PDF (upload real, chip aparece), REMOVER o anexo ANTES
 * de enviar (clique no "×"/aria-label "Remover anexo"), e a mensagem sai SEM o anexo — o `fileId`
 * do upload já confirmado não pode vazar para o POST de mensagem (mesma classe de achado do
 * `AttachmentPicker.handleRemove`/`onRemoved` consertada nesta sessão, provada aqui em UI humana,
 * não só em unit). Complementa `patient-conversation-attachment-rejected...` (1º alternativo:
 * upload recusado pelo SERVIDOR) com um caminho de sucesso que a operadora desfaz por conta própria.
 *
 * Molde: `patient-conversation-attachment-happy.integration.e2e.ts` (T321) — mesma stack, mesmos
 * helpers de seed/login.
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=pg-022-b3 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5174 \
 *   npx playwright test --project=integration e2e/integration/patient-conversation-attachment-removed.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um", corpo "msg-1 sem anexo
 * (removido antes de enviar)", arquivo `e2e/fixtures/sample.pdf` (já existe no repo, sintético).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-rem-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Attach Removed ${RUN_ID}`;
const PDF_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.pdf');

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.use({ video: 'on' });

test.describe('Chat interno por paciente — anexo removido ANTES de enviar @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

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
    safeSql(`DELETE FROM conversation_read_marks WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_id = '${patientId}')`);
  });

  test('anexar PDF, remover antes de enviar, e a mensagem sai sem anexo (fileId confirmado não vaza)', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ── anexar de verdade (upload real, humano) e esperar o CHIP de sucesso (status 'done') ──
    const uploadResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/files$/.test(r.url()));
    await page.getByTestId('composer-attach-input').setInputFiles(PDF_FIXTURE);
    const uploadBody = (await (await uploadResponse).json()) as { data: { fileId: string } };
    expect(uploadBody.data.fileId).toBeTruthy();
    await expect(page.getByTestId('attachment-chip-name')).toHaveText('sample.pdf');

    // ── remover ANTES de enviar — clique humano no "×" pelo aria-label (mesmo texto i18n que o
    // atom usa, `composer.attachments.remove`), nunca por seletor interno de implementação ──
    await page.getByRole('button', { name: 'Remover anexo' }).click();
    await expect(page.getByTestId('attachment-picker-list')).toHaveCount(0);
    await expect(page.getByText('sample.pdf')).toHaveCount(0);

    // ── botão de anexar volta a ficar livre (não fica preso em "1 de 5" com um anexo fixado) ──
    await expect(page.getByTestId('composer-attach-btn')).not.toBeDisabled();

    // ── digita e envia — a mensagem sai SEM fileIds (o anexo removido não pode vazar) ──
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 sem anexo (removido antes de enviar)');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedRequest = (await posted).request();
    const postedPayload = JSON.parse(postedRequest.postData() ?? '{}') as { fileIds?: string[] };
    expect(postedPayload.fileIds).toBeUndefined();

    const postedBody = (await (await posted).json()) as { data: { id: string } };
    const messageId = postedBody.data.id;
    const item = page.getByTestId(`conversation-message-${messageId}`);
    await expect(item).toBeVisible();
    await expect(item.getByTestId('message-body')).toContainText('msg-1 sem anexo');

    // ── a mensagem ENVIADA nunca mostra chip de anexo — o array de attachments dela veio vazio ──
    await expect(item.locator('[data-testid^="message-attachment-"]')).toHaveCount(0);

    // ── conferência direta no banco: o arquivo foi uploadado (existe em stored_files) MAS nunca
    // ficou anexado a mensagem nenhuma — `conversation_message_attachments` continua sem linha
    // para ele, mesmo depois do envio (prova que o servidor também nunca recebeu esse fileId) ──
    const attachedCount = scalar(`SELECT COUNT(*) FROM conversation_message_attachments WHERE file_id = '${uploadBody.data.fileId}'`);
    expect(Number(attachedCount)).toBe(0);
    const storedFilesCount = scalar(`SELECT COUNT(*) FROM stored_files WHERE id = '${uploadBody.data.fileId}'`);
    expect(Number(storedFilesCount)).toBe(1); // controle positivo: o upload aconteceu de verdade

    await expect(panel).toHaveScreenshot('conversation-attachment-removed-before-send.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
