/**
 * patient-conversation-attachment-rejected.integration.e2e.ts @integration — spec 022, Bloco 3, T322.
 *
 * Anexo RECUSADO: selecionar um `.doc` legado (CFB/OLE, mesmo magic byte `D0 CF 11 E0` que o
 * backend usa em `ConversationAttachmentValidator.test.ts`), ver a mensagem de erro específica em
 * tela (`LEGACY_DOC_NOT_ALLOWED` — nunca o texto genérico dos outros 415), e a mensagem NUNCA é
 * criada (sem `fileIds`, o botão de enviar continua desabilitado porque o texto está vazio).
 *
 * Fixture `e2e/fixtures/legacy-doc.doc` — 512 bytes, cabeçalho CFB/OLE puro (sem conteúdo real de
 * documento, sintético), gerado nesta sessão e verificado contra `file-type@16` (o mesmo pacote/
 * versão que o backend usa): `{ ext: 'cfb', mime: 'application/x-cfb' }` → `LEGACY_OFFICE_MIME_TYPES`
 * (`ConversationAttachmentValidator.ts`) → `LEGACY_DOC_NOT_ALLOWED`.
 *
 * Molde: `patient-conversation-attachment-happy.integration.e2e.ts` (T321) — mesma stack, mesmos
 * helpers de seed/login.
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=pg-022-b3 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5174 \
 *   npx playwright test --project=integration e2e/integration/patient-conversation-attachment-rejected.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um".
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
const AUTORA_UID = `e2e-conv-rej-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Attach Rejected ${RUN_ID}`;
const DOC_FIXTURE = path.join(HERE, '..', 'fixtures', 'legacy-doc.doc');

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.use({ video: 'on' });

test.describe('Chat interno por paciente — anexo recusado (.doc legado) @integration', () => {
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

  test('selecionar .doc legado mostra o erro específico; mensagem nunca é criada', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ── selecionar o .doc legado — humano (setInputFiles é o equivalente do seletor do SO). O
    // magic byte (D-14) só o SERVIDOR valida (nunca duplicado no cliente — só tamanho é checado
    // localmente); por isso o picker sobe de verdade e espera o 415 real do backend. ──
    const uploadResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/files$/.test(r.url()));
    await page.getByTestId('composer-attach-input').setInputFiles(DOC_FIXTURE);
    const uploadRes = await uploadResponse;
    expect(uploadRes.status()).toBe(415);
    const uploadErrorBody = (await uploadRes.json()) as { code?: string };
    expect(uploadErrorBody.code).toBe('LEGACY_DOC_NOT_ALLOWED');

    // ── erro ESPECÍFICO em tela (LEGACY_DOC_NOT_ALLOWED) — nunca o texto genérico de 415 ──
    const errorChip = page.getByTestId('attachment-chip-error');
    await expect(errorChip).toBeVisible({ timeout: 10_000 });
    await expect(errorChip).toHaveText('Formato .doc no es aceptado; guardá como .docx');

    // ── o botão de anexar não fica travado: o erro NÃO ocupa vaga (activeCount só conta status
    // !== 'error') — reforça que o achado é "arquivo recusado", não "sistema travado" ──
    await expect(page.getByTestId('composer-attach-btn')).not.toBeDisabled();

    // ── nenhum fileId chega ao servidor: sem POST .../conversation/files bem-sucedido, o array de
    // fileIds do MessageComposer continua vazio — mesmo se a operadora digitar texto e enviar, a
    // mensagem sobe SEM anexo algum (nunca um fileId "fantasma" de um upload recusado) ──
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 sem anexo (doc recusado)');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedRequest = (await posted).request();
    const postedPayload = JSON.parse(postedRequest.postData() ?? '{}') as { fileIds?: string[] };
    expect(postedPayload.fileIds).toBeUndefined();

    // ── conferência direta no banco: NENHUM stored_files novo para este paciente (o 415 do
    // servidor aconteceu ANTES de qualquer INSERT — mesma prova de `conversationAttachmentsFormats.e2e.test.ts` do backend) ──
    const conversationId = scalar(`SELECT id FROM conversations WHERE patient_id = '${patientId}'`);
    const storedFilesCount = scalar(`SELECT COUNT(*) FROM stored_files WHERE conversation_id = '${conversationId}'`);
    expect(Number(storedFilesCount)).toBe(0);

    await expect(panel).toHaveScreenshot('conversation-attachment-rejected-error.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
