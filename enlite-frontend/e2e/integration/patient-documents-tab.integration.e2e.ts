/**
 * patient-documents-tab.integration.e2e.ts @integration — spec 031 (aba "Documentos" da ficha do paciente), F3.
 *
 * E2E DE TELA, sem mock de resposta: API real + Postgres real + fake-gcs, interação HUMANA (click +
 * `keyboard.type`, o valor é LIDO DA TELA). `setInputFiles` só escolhe o arquivo — é o único jeito de
 * "escolher no seletor do SO". Quatro cenários, um `test` cada, sem modo serial (cada um semeia o seu
 * paciente e o seu staff e limpa no `finally`):
 *   1. FELIZ — abrir a aba, subir, ver (sha256 do que baixou == o do fixture), renomear (Enter persiste
 *      após reload, Esc cancela), excluir com diálogo (foco em Cancelar) e continuar excluído após reload;
 *      nome vazio/só espaços mantém "Subir" desabilitado.
 *   2. CHAT CRIA DOCUMENTO + REGRESSÃO DO ENVIO — anexar PDF no chat e enviar pela tela (regressão do
 *      POST da mensagem, que agora grava o documento na mesma transação); a aba mostra UM item
 *      "Enviado por el chat"; excluir pela aba e a mensagem passa a dizer "Documento eliminado";
 *      mensagem de texto sem anexo segue enviando e NÃO cria documento.
 *   3. ALTERNATIVO A — conta sem NENHUMA célula `patient_document`: a aba não existe (controle positivo:
 *      "Red de Apoyo" da mesma conta aparece, então o seletor enxerga a barra de abas).
 *   4. ALTERNATIVO B — cancelar a exclusão (Esc, depois o botão Cancelar): o item continua, também
 *      após reload e no banco.
 *
 * ⚠️ Precisa do engine ABAC LIGADO na API (cenário 3 mede a AUSÊNCIA da aba por falta de célula; com o
 * engine OFF `cells===null` mostra tudo e o cenário ficaria verde sem medir nada) e de fake-gcs com o
 * bucket de `PATIENT_DOCUMENTS_BUCKET`. Por isso vive no job `integration-e2e-group-simulation` do
 * `_frontend-integration.yml` (casa pelo nome do arquivo no `--grep`), que tem as duas coisas.
 *
 * Side-effects do POST da mensagem (mapeados em 02/10): grava linhas no Postgres (mensagem, anexo,
 * documento, `notification_events`/sino) e o objeto no fake-gcs. Nenhum e-mail/WhatsApp/push/HTTP
 * externo — `inapp-notification`, `conversation` e `patient-documents` não importam cliente de canal
 * (grep) e o compose de teste zera SENDGRID e aponta Periskope/Twilio para stub/ausente. KMS fica em
 * passthrough (`USE_KMS_ENCRYPTION=false`). Não menciona ninguém (sem `<@uid>`), então o fan-out nem
 * cria sino para terceiros.
 *
 * Rodar local = o job do CI: ver o cabeçalho de `abac-stack-helper.ts` + `ABAC_API_URL`,
 * `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL` e `PW_BASE_URL`.
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "E2E <uid>", arquivo `e2e/fixtures/sample.pdf`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, scalar,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.pdf');
const PDF_BYTES = readFileSync(PDF_FIXTURE);
const PDF_SHA256 = createHash('sha256').update(PDF_BYTES).digest('hex');
const PDF_SIZE = statSync(PDF_FIXTURE).size;

const TAB_BAR = 'patient-profile-tabs';

/**
 * A API dentro do docker assina a URL com o host da REDE do compose (`http://fake-gcs:4443/...`, o
 * `GCS_EMULATOR_HOST` dela), que o navegador do runner/da máquina não resolve. Isto só troca o HOST do
 * pedido pelo endereço publicado do MESMO fake-gcs (`E2E_FAKE_GCS_URL`, default a porta do CI) — o
 * pedido segue para o emulador real e os bytes são os que a API gravou; nenhuma resposta é fabricada.
 */
const FAKE_GCS_PUBLIC = process.env.E2E_FAKE_GCS_URL ?? 'http://localhost:54443';

/** Print-chave para a evidência — só grava quando `E2E_EVIDENCE_DIR` está setado (no CI não escreve nada). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (!dir) return;
  await page.waitForTimeout(450); // a transição do painel do chat (300 ms) e a do menu terminam antes do print
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

interface Seeded { patientId: string; groupId: string; user: MockUser }

/** Paciente sintético + staff com um grupo escopado a AR e as células pedidas (`resource:action`). */
function seed(tag: string, cells: Array<[string, string]>): Seeded {
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const uid = `e2e-pdoc-${tag}-${run}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'recruiter', country: 'AR' };
  const patientId = seedPatientQA();
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `E2E PatientDocs ${tag} ${run}`, country: 'AR' });
  for (const [resource, action] of cells) grantCell(groupId, resource, action);
  return { patientId, groupId, user };
}

function cleanup(s: Seeded): void {
  safeSql(`DELETE FROM conversation_read_marks WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_id = '${s.patientId}')`);
  safeSql(`DELETE FROM patient_documents WHERE patient_id = '${s.patientId}'`);
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  cleanupPatientQA(s.patientId);
}

const docCount = (patientId: string): number =>
  Number(scalar(`SELECT count(*) FROM patient_documents WHERE patient_id = '${patientId}'`));

const ALL_DOC_CELLS: Array<[string, string]> = [
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_family', 'read'],
  ['patient_document', 'read'], ['patient_document', 'create'], ['patient_document', 'update'], ['patient_document', 'delete'],
];

function tabButton(page: Page, name: string): Locator {
  return page.getByTestId(TAB_BAR).getByRole('button', { name, exact: true });
}

async function openPatient(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
}

async function openDocumentsTab(page: Page): Promise<void> {
  const tab = tabButton(page, 'Documentos');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByTestId('patient-documents-section')).toBeVisible();
  // a lista só aparece depois do GET: ou vem vazia ("No hay documentos") ou com itens.
  await expect(page.getByTestId('patient-documents-loading')).toHaveCount(0);
}

/** Clica no campo, confere o foco, limpa e digita — como uma pessoa. */
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await field.click();
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.type(text);
  await expect(field).toHaveValue(text);
}

/** Sobe pela tela: digita o nome, escolhe o PDF, clica em "Subir"; devolve o id lido do POST real. */
async function uploadViaUi(page: Page, name: string): Promise<string> {
  await typeInto(page, page.getByTestId('patient-document-label-input'), name);
  await page.getByTestId('patient-document-file-input').setInputFiles(PDF_FIXTURE);
  await expect(page.getByTestId('patient-document-file-name')).toHaveText('sample.pdf');
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/patients\/[^/]+\/documents$/.test(r.url()));
  await page.getByTestId('patient-document-upload').click();
  const res = await posted;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  expect(body.data.id).toBeTruthy();
  return body.data.id;
}

test.use({ video: 'on', trace: 'on', viewport: { width: 1280, height: 1100 } });

test.describe('Documentos do paciente — aba na ficha @integration', () => {
  test.setTimeout(150_000);

  test('feliz: subir, ver, renomear (Enter/Esc), excluir com confirmação, tudo persiste após reload', async ({ page, context }) => {
    const s = seed('feliz', ALL_DOC_CELLS);
    try {
      await context.route('http://fake-gcs:4443/**', (route) => {
        const u = new URL(route.request().url());
        return route.continue({ url: `${FAKE_GCS_PUBLIC}${u.pathname}${u.search}` });
      });
      await loginAs(page, s.user);
      await openPatient(page, s.patientId);

      // A aba vem DEPOIS de "Red de Apoyo" (D463).
      const labels = await page.getByTestId(TAB_BAR).getByRole('button').allInnerTexts();
      const iSupport = labels.indexOf('Red de Apoyo');
      expect(iSupport).toBeGreaterThanOrEqual(0);
      expect(labels[iSupport + 1]).toBe('Documentos');

      await openDocumentsTab(page);
      await expect(page.getByTestId('patient-documents-empty')).toHaveText('No hay documentos');
      await shot(page, '1-feliz-01-aba-vazia');

      // Nome vazio / só espaços → "Subir" desabilitado, mesmo com arquivo escolhido.
      const submit = page.getByTestId('patient-document-upload');
      await expect(submit).toBeDisabled();
      await page.getByTestId('patient-document-file-input').setInputFiles(PDF_FIXTURE);
      await expect(page.getByTestId('patient-document-file-name')).toHaveText('sample.pdf');
      await expect(submit).toBeDisabled();
      await typeInto(page, page.getByTestId('patient-document-label-input'), '   ');
      await expect(submit).toBeDisabled();

      // Nome de verdade → habilita e sobe.
      const NOME = 'DNI frente QA';
      const docId = await uploadViaUi(page, NOME);
      const row = page.getByTestId(`patient-document-row-${docId}`);
      await expect(row).toBeVisible();
      await expect(page.getByTestId(`patient-document-name-${docId}`)).toHaveText(NOME);
      const meta = page.getByTestId(`patient-document-meta-${docId}`);
      await expect(meta).toContainText('Subido en la ficha');
      await expect(meta).toContainText(`Por E2E ${s.user.uid}`);
      await expect(meta).toContainText(/\d{1,2}:\d{2}/);
      await expect(page.getByTestId('patient-documents-empty')).toHaveCount(0);
      await expect(page.getByTestId('patient-document-label-input')).toHaveValue('');
      await shot(page, '1-feliz-02-item-subido');

      // "Ver": abre a aba auxiliar e o navegador BAIXA o arquivo — o sha256 do que chegou é o do fixture.
      const [popup] = await Promise.all([context.waitForEvent('page'), page.getByTestId(`patient-document-view-${docId}`).click()]);
      const download = await popup.waitForEvent('download', { timeout: 15_000 });
      const saved = path.join(os.tmpdir(), `e031-${docId}.pdf`);
      await download.saveAs(saved);
      const got = readFileSync(saved);
      expect(got.length).toBe(PDF_SIZE);
      expect(createHash('sha256').update(got).digest('hex')).toBe(PDF_SHA256);

      // Renomear: lápis → campo focado → digitar → Enter; depois do reload o nome novo persiste.
      const NOVO = 'Documento renomeado QA';
      await page.getByTestId(`patient-document-rename-${docId}`).click();
      const input = page.getByTestId(`patient-document-rename-input-${docId}`);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(NOME);
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(NOVO);
      await expect(input).toHaveValue(NOVO);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId(`patient-document-name-${docId}`)).toHaveText(NOVO);

      await page.reload();
      await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
      await openDocumentsTab(page);
      await expect(page.getByTestId(`patient-document-name-${docId}`)).toHaveText(NOVO);
      await shot(page, '1-feliz-03-renomeado-apos-reload');

      // Esc numa segunda edição cancela: o que foi digitado não vai para a lista.
      await page.getByTestId(`patient-document-rename-${docId}`).click();
      await expect(input).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('nome que nao deve salvar');
      await page.keyboard.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(page.getByTestId(`patient-document-name-${docId}`)).toHaveText(NOVO);

      // Excluir: diálogo com foco em "Cancelar"; confirmar remove; reload mantém removido.
      await page.getByTestId(`patient-document-delete-${docId}`).click();
      const dialog = page.getByTestId('patient-document-delete-confirm');
      await expect(dialog).toBeVisible();
      await shot(page, '1-feliz-04-dialogo-excluir');
      await expect(page.getByTestId('patient-document-delete-name')).toHaveText(NOVO);
      await expect(page.getByTestId('patient-document-delete-cancel')).toBeFocused();
      await page.getByTestId('patient-document-delete-yes').click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId('patient-documents-empty')).toHaveText('No hay documentos');

      await page.reload();
      await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
      await openDocumentsTab(page);
      await expect(page.getByTestId('patient-documents-empty')).toHaveText('No hay documentos');
      await expect(page.getByTestId(`patient-document-row-${docId}`)).toHaveCount(0);
      expect(docCount(s.patientId)).toBe(0);
    } finally {
      cleanup(s);
    }
  });

  test('chat cria o documento: anexo enviado pela tela aparece na aba, excluir na aba vira "Documento eliminado" na mensagem', async ({ page }) => {
    const s = seed('chat', [
      ...ALL_DOC_CELLS,
      ['patient_conversation', 'read'], ['patient_conversation', 'create'],
    ]);
    try {
      await loginAs(page, s.user);
      await openPatient(page, s.patientId);

      await page.getByTestId('patient-conversation-handle-btn').click();
      const panel = page.getByTestId('patient-conversation-panel');
      await expect(panel).toBeVisible();

      // Regressão do envio: texto SEM anexo continua enviando (e não cria documento).
      const editor = page.getByTestId('composer-editor');
      await editor.click();
      await expect(editor).toBeFocused();
      await page.keyboard.type('msg-texto sem anexo');
      const postedText = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
      await page.getByTestId('composer-send-btn').click();
      const textRes = await postedText;
      expect(textRes.status()).toBe(201);
      const textId = ((await textRes.json()) as { data: { id: string } }).data.id;
      await expect(page.getByTestId(`conversation-message-${textId}`).getByTestId('message-body')).toContainText('msg-texto sem anexo');
      expect(docCount(s.patientId)).toBe(0);

      // Anexar o PDF e enviar a mensagem pela tela.
      const uploadResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/files$/.test(r.url()));
      await page.getByTestId('composer-attach-input').setInputFiles(PDF_FIXTURE);
      expect((await uploadResponse).status()).toBe(201);
      await expect(page.getByTestId('attachment-chip-name')).toHaveText('sample.pdf');
      await editor.click();
      await expect(editor).toBeFocused();
      await page.keyboard.type('msg-com anexo');
      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
      await page.getByTestId('composer-send-btn').click();
      const res = await posted;
      expect(res.status()).toBe(201);
      const messageId = ((await res.json()) as { data: { id: string } }).data.id;
      const item = page.getByTestId(`conversation-message-${messageId}`);
      await expect(item.getByTestId('message-body')).toContainText('msg-com anexo');
      const chip = item.locator('[data-testid^="message-attachment-"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('sample.pdf');
      await shot(page, '2-chat-01-mensagem-com-anexo');

      // Fecha o painel (rascunho vazio → Esc fecha) e abre a aba: UM item, "Enviado por el chat", nome do arquivo.
      await page.keyboard.press('Escape');
      // fechado = fora da tela (`translate-x-full`); o nó continua no DOM, então não é `hidden` para o Playwright
      await expect(panel).toHaveClass(/translate-x-full/);
      await openDocumentsTab(page);
      const rows = page.locator('[data-testid^="patient-document-row-"]');
      await expect(rows).toHaveCount(1);
      await expect(rows.first().locator('[data-testid^="patient-document-name-"]')).toHaveText('sample.pdf');
      await expect(rows.first().locator('[data-testid^="patient-document-meta-"]')).toContainText('Enviado por el chat');
      await shot(page, '2-chat-02-aba-com-item-do-chat');

      // Excluir pela aba, confirmando.
      await rows.first().locator('[data-testid^="patient-document-delete-"]').click();
      await expect(page.getByTestId('patient-document-delete-cancel')).toBeFocused();
      await page.getByTestId('patient-document-delete-yes').click();
      await expect(rows).toHaveCount(0);
      await expect(page.getByTestId('patient-documents-empty')).toHaveText('No hay documentos');
      expect(docCount(s.patientId)).toBe(0);

      // O chat mostra "Documento eliminado" no lugar do anexo (e a mensagem de texto segue lá).
      await page.getByTestId('patient-conversation-handle-btn').click();
      await expect(panel).toHaveClass(/translate-x-0/);
      const itemAgain = page.getByTestId(`conversation-message-${messageId}`);
      await expect(itemAgain.getByTestId('message-body')).toContainText('msg-com anexo');
      await expect(itemAgain.locator('[data-testid^="message-attachment-deleted-"]')).toContainText('Documento eliminado');
      await expect(itemAgain.getByText('sample.pdf')).toHaveCount(0);
      await shot(page, '2-chat-03-documento-eliminado-no-chat');
      await expect(page.getByTestId(`conversation-message-${textId}`)).toBeVisible();
    } finally {
      cleanup(s);
    }
  });

  test('alternativo A: conta sem nenhuma célula patient_document não vê a aba', async ({ page }) => {
    const s = seed('sem-celula', [['patient', 'read'], ['patient_identity', 'read'], ['patient_family', 'read']]);
    try {
      await loginAs(page, s.user);
      await openPatient(page, s.patientId);
      // Controle positivo: a mesma barra mostra "Red de Apoyo" — o seletor enxerga as abas.
      await expect(tabButton(page, 'Red de Apoyo')).toBeVisible();
      await expect(tabButton(page, 'Documentos')).toHaveCount(0);
      await expect(page.getByTestId('patient-documents-section')).toHaveCount(0);
      await shot(page, '3-sem-celula-sem-aba');
    } finally {
      cleanup(s);
    }
  });

  test('alternativo B: cancelar a exclusão (Esc e botão Cancelar) mantém o documento, também após reload', async ({ page }) => {
    const s = seed('cancelar', ALL_DOC_CELLS);
    try {
      await loginAs(page, s.user);
      await openPatient(page, s.patientId);
      await openDocumentsTab(page);
      const docId = await uploadViaUi(page, 'Documento para cancelar QA');
      const row = page.getByTestId(`patient-document-row-${docId}`);
      await expect(row).toBeVisible();

      // 1) Esc fecha o diálogo e o item continua.
      await page.getByTestId(`patient-document-delete-${docId}`).click();
      const dialog = page.getByTestId('patient-document-delete-confirm');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('patient-document-delete-cancel')).toBeFocused();
      await shot(page, '4-cancelar-01-dialogo');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(row).toBeVisible();

      // 2) Botão "Cancelar" idem; reload e banco confirmam que nada foi apagado.
      await page.getByTestId(`patient-document-delete-${docId}`).click();
      await expect(dialog).toBeVisible();
      await page.getByTestId('patient-document-delete-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toBeVisible();

      await page.reload();
      await expect(page.getByTestId(TAB_BAR)).toBeVisible({ timeout: 20_000 });
      await openDocumentsTab(page);
      await expect(page.getByTestId(`patient-document-name-${docId}`)).toHaveText('Documento para cancelar QA');
      expect(docCount(s.patientId)).toBe(1);
      await shot(page, '4-cancelar-02-item-continua-apos-reload');
    } finally {
      cleanup(s);
    }
  });
});
