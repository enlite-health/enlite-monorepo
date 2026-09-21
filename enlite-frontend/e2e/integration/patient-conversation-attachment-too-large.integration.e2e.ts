/**
 * patient-conversation-attachment-too-large.integration.e2e.ts @integration — spec 022, Bloco 3
 * (conserto do gate revisao-pr B3-r2, item 2 do brief de conserto: "e2e Playwright: alternativo em
 * que o SERVIDOR recusa — arquivo > 10 MB → 413 com mensagem visível na tela").
 *
 * `patient-conversation-attachment-rejected...` já cobre o SERVIDOR recusando por CONTEÚDO (magic
 * byte de `.doc` legado, D-14). Este spec cobre o SERVIDOR recusando por TAMANHO — o 2º eixo do
 * mesmo `multer.limits.fileSize` (`ConversationAttachmentPolicy.MAX_ATTACHMENT_BYTES`, 10 MB).
 *
 * 🔒 Por que a interceptação de rede, e não só `setInputFiles` de um arquivo grande: o CLIENTE já
 * bloqueia `file.size > 10 MB` ANTES de qualquer chamada de rede (`AttachmentPicker.tsx`, resposta
 * rápida pra não gastar banda da operadora) — selecionar um arquivo real de +10 MB pela UI nunca
 * chega ao servidor, e o achado a fechar é justamente "o servidor recusa de verdade, não só o
 * cliente confia". A operadora seleciona um PDF válido e pequeno pela UI HUMANA de verdade
 * (`setInputFiles`, mesmo fixture dos outros specs deste bloco) — só a REQUISIÇÃO DE REDE que sai
 * desse clique tem o corpo substituído por um multipart genuinamente maior que 10 MB, montado em
 * MEMÓRIA agora (nunca escrito em disco, nunca commitado — "gere o fixture em tempo de teste, não
 * commite binário grande"). O `multer` do backend REAL processa esse corpo e recusa por
 * `LIMIT_FILE_SIZE` antes de qualquer código de aplicação rodar (`withMulterErrorAsJson.ts`) — o
 * 413 e o `code: 'FILE_TOO_LARGE'` são do SERVIDOR de verdade, não fabricados no teste.
 *
 * Molde: `patient-conversation-attachment-rejected.integration.e2e.ts` (T322) — mesma stack, mesmos
 * helpers de seed/login; troca a causa da recusa (conteúdo → tamanho) e a técnica de fixture
 * (arquivo commitado → multipart oversized em memória).
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=pg-022-b3 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5174 \
 *   npx playwright test --project=integration e2e/integration/patient-conversation-attachment-too-large.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um".
 */
import { test, expect, type Route } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-big-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Attach TooLarge ${RUN_ID}`;
const PDF_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.pdf'); // válido e pequeno — o que a UI de fato seleciona
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // D-14, mesmo valor de ConversationAttachmentPolicy.ts

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

/**
 * Multipart/form-data com um campo de arquivo GENUINAMENTE maior que `sizeBytes` — gerado em
 * memória, nunca gravado em disco. O conteúdo é lixo (`0x25` repetido): o `multer.limits.fileSize`
 * conta bytes do STREAM antes de qualquer validação de conteúdo (magic byte/`file-type`), então o
 * 413 dispara sem precisar de um PDF de verdade.
 */
function buildOversizedMultipart(fieldName: string, filename: string, sizeBytes: number): { body: Buffer; contentType: string } {
  const boundary = `----playwright-oversized-${RUN_ID}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
    + `Content-Type: application/pdf\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.alloc(sizeBytes, 0x25);
  return { body: Buffer.concat([head, payload, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

test.use({ video: 'on' });

test.describe('Chat interno por paciente — anexo maior que 10 MB recusado pelo SERVIDOR (413) @integration', () => {
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

  test('selecionar um PDF válido cuja requisição de rede chega ao servidor com +10 MB: 413 real, mensagem visível, mensagem nunca é criada', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    const oversized = buildOversizedMultipart('file', 'grande.pdf', MAX_ATTACHMENT_BYTES + 1024);
    // Registrado DEPOIS do `loginAs` (que já registrou `**/api/**` trocando o Authorization) —
    // Playwright invoca o handler mais RECÉM-registrado primeiro, então este roda antes do
    // `swapToken` genérico; por isso ele mesmo troca o Authorization (evidência: `tokenFor`).
    await page.route('**/conversation/files', async (route: Route) => {
      const headers = { ...route.request().headers() };
      delete headers['content-length'];
      headers['content-type'] = oversized.contentType;
      headers['authorization'] = `Bearer ${tokenFor(AUTORA)}`;
      await route.continue({ headers, postData: oversized.body });
    }, { times: 1 });

    // ── selecionar um PDF VÁLIDO e pequeno pela UI de verdade (humano) — passa o guard do
    // CLIENTE (369 bytes < 10 MB); só a rede que sai desse clique carrega o corpo oversized. ──
    const uploadResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/files$/.test(r.url()));
    await page.getByTestId('composer-attach-input').setInputFiles(PDF_FIXTURE);
    const uploadRes = await uploadResponse;
    expect(uploadRes.status()).toBe(413);
    const uploadErrorBody = (await uploadRes.json()) as { code?: string };
    expect(uploadErrorBody.code).toBe('FILE_TOO_LARGE');

    // ── erro visível em tela, por PAPEL/TEXTO (nunca falha muda) — `getByRole('alert')` é o único
    // alerta na tela neste ponto (nenhum outro anexo/erro pendente) ──
    const errorAlert = page.getByRole('alert');
    await expect(errorAlert).toBeVisible({ timeout: 10_000 });
    await expect(errorAlert).toHaveText('El archivo supera los 10 MB');
    await expect(page.getByText('El archivo supera los 10 MB')).toBeVisible();

    // ── o botão de anexar não fica travado (mesma régua do outro alternativo de recusa) ──
    await expect(page.getByTestId('composer-attach-btn')).not.toBeDisabled();

    // ── nenhum fileId chega ao servidor: a mensagem segue sem anexo ──
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 sem anexo (arquivo grande recusado pelo servidor)');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedRequest = (await posted).request();
    const postedPayload = JSON.parse(postedRequest.postData() ?? '{}') as { fileIds?: string[] };
    expect(postedPayload.fileIds).toBeUndefined();

    // ── conferência direta no banco: o multer recusou ANTES de qualquer INSERT em stored_files ──
    const conversationId = scalar(`SELECT id FROM conversations WHERE patient_id = '${patientId}'`);
    const storedFilesCount = scalar(`SELECT COUNT(*) FROM stored_files WHERE conversation_id = '${conversationId}'`);
    expect(Number(storedFilesCount)).toBe(0);

    await expect(panel).toHaveScreenshot('conversation-attachment-too-large-error.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
