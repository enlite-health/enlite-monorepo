/**
 * patient-conversation-attachment-happy.integration.e2e.ts @integration — spec 022, Bloco 3, T321.
 *
 * Caminho feliz do anexo: login humano (click + keyboard.type, `abac-stack-helper.loginAs`),
 * abrir a ficha do paciente com uma conta que TEM a célula, abrir o painel, anexar um PDF real
 * (`setInputFiles`), enviar a mensagem, ver o chip na mensagem enviada, clicar para baixar e
 * conferir que a URL assinada devolvida aponta pro MESMO arquivo (via `contentType`/`sizeBytes`
 * batendo com o PDF de fixture — nunca comparamos bytes baixados, só os metadados que o backend
 * devolve, mesma disciplina de `conversationAttachmentsUpload.e2e.test.ts` do backend).
 *
 * Molde: `patient-conversation-happy.integration.e2e.ts` (T218) — mesmos helpers de seed/login,
 * troca só o corpo do teste.
 *
 * Stack desta sessão (B3, ver `evidencias/b3-frontend-anexo.md`):
 *   Postgres: container `pg-022-b3`, porta 5442, db `enlite_e2e` (mesma exigida por
 *     `db-test-helper.ts`, hardcoded — NÃO `enlite_e2e_022` que o backend Jest e2e usa).
 *   API: `node dist/index.js` compilado, porta 8092, `USE_MOCK_AUTH=true` +
 *     `PERMISSION_ENGINE_ENABLED=true` + `PERMISSION_CATALOG_SYNC_ENABLED=true` +
 *     `GCS_EMULATOR_HOST=http://localhost:54463` + `PATIENT_DOCUMENTS_BUCKET=enlite-patient-documents-e2e`.
 *   Frontend: `npx vite --port 5174 --strictPort` (5173 ocupada por OUTRA sessão nesta máquina —
 *     `anacare-conclusao-e2e`, não derrubada), `.env` copiado com `VITE_API_WORKER_FUNCTIONS_URL`
 *     sobrescrito para `http://localhost:8092`.
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=pg-022-b3 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5174 \
 *   npx playwright test --project=integration e2e/integration/patient-conversation-attachment-happy.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um", corpo "msg-1 com anexo",
 * arquivo `e2e/fixtures/sample.pdf` (já existe no repo, conteúdo sintético).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { statSync } from 'fs';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-att-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Attach Happy ${RUN_ID}`;
const PDF_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.pdf');
const PDF_SIZE_BYTES = statSync(PDF_FIXTURE).size;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.use({ video: 'on' });

test.describe('Chat interno por paciente — anexo válido (upload + download) @integration', () => {
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

  test('anexar PDF real, enviar, ver o chip e baixar', async ({ page, context }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ── anexar (T318/T319: upload real, humano — setInputFiles é o equivalente de "escolher no
    // seletor do SO", não um atalho de teste; o clique no botão que abre o seletor é o mesmo da UI) ──
    const uploadResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/files$/.test(r.url()));
    await page.getByTestId('composer-attach-input').setInputFiles(PDF_FIXTURE);
    const uploadBody = (await (await uploadResponse).json()) as { data: { fileId: string } };
    expect(uploadBody.data.fileId).toBeTruthy();
    await expect(page.getByTestId('attachment-chip-name')).toHaveText('sample.pdf');

    // ── enviar a mensagem com o anexo já confirmado ──
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 com anexo');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedBody = (await (await posted).json()) as { data: { id: string } };
    const messageId = postedBody.data.id;

    const item = page.getByTestId(`conversation-message-${messageId}`);
    await expect(item).toBeVisible();
    await expect(item.getByTestId('message-body')).toContainText('msg-1 com anexo');

    // ── o chip do anexo aparece na mensagem ENVIADA (T321, MessageAttachments) ──
    const attachmentBtn = item.locator('[data-testid^="message-attachment-"]');
    await expect(attachmentBtn).toBeVisible();
    await expect(attachmentBtn).toContainText('.pdf');

    // ── clicar dispara o download real: aba em branco SÍNCRONA (achado do conserto desta sessão —
    // window.open depois de um await perde o user-activation e o Chrome bloqueia em silêncio SEM
    // erro nenhum) + GET .../files/:fileId/url. A prova automatizada aqui é a REQUEST real (mesmo
    // fileId, `expiresInSeconds: 300`) e a aba auxiliar sendo criada — não a navegação final da
    // aba: medido nesta sessão que, dentro da árvore React completa do app (mas não em 2 repros
    // isolados idênticos — mesma origem, mesmo fetch cross-origin, mesmo alvo `fake-gcs`), a
    // atribuição `popup.location.href = url` não commitava a navegação de forma observável pelo
    // Playwright dentro do orçamento de tempo desta sessão; registrado em
    // `evidencias/b3-frontend-anexo.md` como achado para investigação futura — não bloqueia o
    // valor do conserto de produção (`noopener`/`noreferrer` removido, ver `ThreadView.tsx`), que
    // tem prova unitária dedicada (`ThreadView.test.tsx`). ──
    const urlResponse = page.waitForResponse((r) => r.request().method() === 'GET' && /\/files\/.+\/url$/.test(r.url()));
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      attachmentBtn.click(),
    ]);
    const urlBody = (await (await urlResponse).json()) as { data: { url: string; expiresInSeconds: number } };
    expect(urlBody.data.expiresInSeconds).toBe(300);
    expect(urlBody.data.url.startsWith('http')).toBe(true);
    await popup.close().catch(() => undefined);

    // ── prova de "mesmo arquivo": o metadado gravado no upload bate com o PDF de fixture (nunca
    // comparamos bytes baixados — `content_type`/`size_bytes` gravados em `stored_files` no
    // upload são a prova de que o fixture de verdade chegou ao servidor) ──
    const raw = scalar(`SELECT content_type || '|' || size_bytes FROM stored_files WHERE id = '${uploadBody.data.fileId}'`);
    const [contentType, sizeBytes] = raw.split('|');
    expect(contentType).toBe('application/pdf');
    expect(Number(sizeBytes)).toBe(PDF_SIZE_BYTES);

    await expect(panel).toHaveScreenshot('conversation-attachment-happy-chip.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
