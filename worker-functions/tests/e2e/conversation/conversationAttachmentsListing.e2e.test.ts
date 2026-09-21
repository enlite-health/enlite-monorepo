/**
 * conversationAttachmentsListing.e2e.test.ts — spec 022, Bloco 3 (achado fechado nesta sessão,
 * `evidencias/b3-backend-anexo.md` §Achados). HTTP real (app em processo), Postgres real, GCS real
 * (fake-gcs-server via `GCS_EMULATOR_HOST`), engine ABAC LIGADO. Molde:
 * `conversationAttachmentsUpload.e2e.test.ts` (mesmo fixture/harness).
 *
 * Prova que `GET .../conversation` e `GET .../conversation/messages/:mid/replies` devolvem
 * `attachments` populado a partir de `conversation_message_attachments`/`stored_files` — até esta
 * sessão o array saía sempre `[]`, mesmo para mensagem com anexo real gravado.
 *
 * Como rodar:
 *   docker run -d --name fake-gcs-022-b3 -p 54463:4443 fsouza/fake-gcs-server:1.52.2 \
 *     -scheme http -public-host localhost:54463
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *     npx jest --config jest.config.e2e.js tests/e2e/conversation/conversationAttachmentsListing.e2e.test.ts
 */
import {
  setupAttachmentsFixture,
  teardownAttachmentsFixture,
  upload,
  type AttachmentsFixture,
} from './attachmentsE2eHelpers';
import { tokenMock } from '../helpers/permissionFamilyHarness';

const PREFIX = 'b302'; // hex-safe (entra em coluna uuid do paciente) — listagem de anexos
const GRUPO_NOME = `E022 B3 ${PREFIX} Completa`;
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');

async function postMessage(
  fixture: AttachmentsFixture,
  patientId: string,
  body: { body: string; rootMessageId?: string; fileIds?: string[] },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${fixture.app.url}/api/admin/patients/${patientId}/conversation/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: tokenMock(fixture.uidCompleta, 'admin', 'AR') },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getConversation(fixture: AttachmentsFixture, patientId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${fixture.app.url}/api/admin/patients/${patientId}/conversation`, {
    headers: { Authorization: tokenMock(fixture.uidCompleta, 'admin', 'AR') },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getReplies(fixture: AttachmentsFixture, patientId: string, mid: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${fixture.app.url}/api/admin/patients/${patientId}/conversation/messages/${mid}/replies`, {
    headers: { Authorization: tokenMock(fixture.uidCompleta, 'admin', 'AR') },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('GET .../conversation e GET .../replies — attachments populado (achado do Bloco 3)', () => {
  let fixture: AttachmentsFixture;

  beforeAll(async () => {
    fixture = await setupAttachmentsFixture(PREFIX);
  }, 30000);

  afterAll(async () => {
    await teardownAttachmentsFixture(fixture, GRUPO_NOME);
  });

  it('1. mensagem de topo com 1 anexo: GET .../conversation devolve attachments.length === 1 com a forma do contrato', async () => {
    const uploadRes = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, PDF_BYTES, 'doc.pdf', 'application/pdf');
    expect(uploadRes.status).toBe(201);
    const fileId = uploadRes.body.data.fileId;

    const postRes = await postMessage(fixture, fixture.patient, { body: 'mensagem com anexo', fileIds: [fileId] });
    expect(postRes.status).toBe(201);
    const messageId = postRes.body.data.id;

    const getRes = await getConversation(fixture, fixture.patient);
    expect(getRes.status).toBe(200);
    const message = getRes.body.data.messages.find((m: { id: string }) => m.id === messageId);
    expect(message).toBeDefined();
    expect(message.attachments).toHaveLength(1);
    // 🔒 achado T-nome-anexo (ajustes de UI): a listagem agora TAMBÉM devolve `originalName`
    // decifrado — antes só saía no download. forma EXATA do contrato, sem campo extra vazando.
    expect(message.attachments[0]).toEqual({ fileId, contentType: 'application/pdf', sizeBytes: PDF_BYTES.length, originalName: 'doc.pdf' });
    expect(Object.keys(message.attachments[0]).sort()).toEqual(['contentType', 'fileId', 'originalName', 'sizeBytes']);
  });

  it('2. mensagem sem anexo, na MESMA conversa que tem mensagem com anexo: attachments: [] (agregação não vaza entre mensagens)', async () => {
    const postRes = await postMessage(fixture, fixture.patient, { body: 'mensagem sem anexo, mesma conversa' });
    expect(postRes.status).toBe(201);
    const messageId = postRes.body.data.id;

    const getRes = await getConversation(fixture, fixture.patient);
    const message = getRes.body.data.messages.find((m: { id: string }) => m.id === messageId);
    expect(message.attachments).toEqual([]);
  });

  it('3. anexo de OUTRO paciente não aparece: mensagem do paciente B com seu próprio anexo não vaza pro paciente A, e vice-versa', async () => {
    const uploadA = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, PDF_BYTES, 'a.pdf', 'application/pdf');
    const postA = await postMessage(fixture, fixture.patient, { body: 'anexo do paciente A', fileIds: [uploadA.body.data.fileId] });

    const uploadB = await upload(fixture.app, `/api/admin/patients/${fixture.patientOutro}/conversation/files`, fixture.uidCompleta, PDF_BYTES, 'b.pdf', 'application/pdf');
    const postB = await postMessage(fixture, fixture.patientOutro, { body: 'anexo do paciente B', fileIds: [uploadB.body.data.fileId] });

    const conversationA = await getConversation(fixture, fixture.patient);
    const messageA = conversationA.body.data.messages.find((m: { id: string }) => m.id === postA.body.data.id);
    expect(messageA.attachments).toEqual([{ fileId: uploadA.body.data.fileId, contentType: 'application/pdf', sizeBytes: PDF_BYTES.length, originalName: 'a.pdf' }]);
    // o fileId de B nunca aparece em NENHUMA mensagem da conversa de A.
    const todosAnexosDeA = conversationA.body.data.messages.flatMap((m: { attachments: Array<{ fileId: string }> }) => m.attachments.map((a) => a.fileId));
    expect(todosAnexosDeA).not.toContain(uploadB.body.data.fileId);

    const conversationB = await getConversation(fixture, fixture.patientOutro);
    const messageB = conversationB.body.data.messages.find((m: { id: string }) => m.id === postB.body.data.id);
    expect(messageB.attachments).toEqual([{ fileId: uploadB.body.data.fileId, contentType: 'application/pdf', sizeBytes: PDF_BYTES.length, originalName: 'b.pdf' }]);
    const todosAnexosDeB = conversationB.body.data.messages.flatMap((m: { attachments: Array<{ fileId: string }> }) => m.attachments.map((a) => a.fileId));
    expect(todosAnexosDeB).not.toContain(uploadA.body.data.fileId);
  });

  it('4. reply com anexo: GET .../replies também devolve attachments populado (mesma agregação de listReplies)', async () => {
    const rootRes = await postMessage(fixture, fixture.patient, { body: 'root da thread com reply anexada' });
    const rootId = rootRes.body.data.id;

    const uploadReply = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, PDF_BYTES, 'reply.pdf', 'application/pdf');
    const replyRes = await postMessage(fixture, fixture.patient, { body: 'reply com anexo', rootMessageId: rootId, fileIds: [uploadReply.body.data.fileId] });
    expect(replyRes.status).toBe(201);

    const repliesRes = await getReplies(fixture, fixture.patient, rootId);
    expect(repliesRes.status).toBe(200);
    const reply = repliesRes.body.data.messages.find((m: { id: string }) => m.id === replyRes.body.data.id);
    expect(reply.attachments).toEqual([{ fileId: uploadReply.body.data.fileId, contentType: 'application/pdf', sizeBytes: PDF_BYTES.length, originalName: 'reply.pdf' }]);
  });
});
