/**
 * conversationAttachmentsDownload.e2e.test.ts — spec 022, Bloco 3 (T314/T315). HTTP real, Postgres
 * real, GCS real (fake-gcs). Prova: signed URL v4 300s com `responseDisposition: attachment` e
 * nome original DECIFRADO; 403/404 sem vazar existência de arquivo de outro paciente; 404 quando o
 * arquivo foi só uploadado mas NUNCA anexado a mensagem nenhuma.
 *
 * Como rodar: mesma stack de `conversationAttachmentsUpload.e2e.test.ts`.
 */
import {
  setupAttachmentsFixture,
  teardownAttachmentsFixture,
  upload,
  chamar,
  type AttachmentsFixture,
} from './attachmentsE2eHelpers';

const PREFIX = 'b302'; // hex-safe — download
const GRUPO_NOME = `E022 B3 ${PREFIX} Completa`;

async function postMessageWithFile(fixture: AttachmentsFixture, uid: string, fileId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${fixture.app.url}/api/admin/patients/${fixture.patient}/conversation/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: (await import('../helpers/permissionFamilyHarness')).tokenMock(uid, 'admin', 'AR') },
    body: JSON.stringify({ body: 'mensagem com anexo', fileIds: [fileId] }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('GET /api/admin/patients/:id/conversation/files/:fileId/url — download (spec 022, Bloco 3, T314/T315)', () => {
  let fixture: AttachmentsFixture;

  beforeAll(async () => {
    fixture = await setupAttachmentsFixture(PREFIX);
  }, 30000);

  afterAll(async () => {
    await teardownAttachmentsFixture(fixture, GRUPO_NOME);
  });

  it('1. fileId anexado a uma mensagem da conversa do paciente — 200 com url + expiresInSeconds=300, filename original no Content-Disposition (via URL assinada)', async () => {
    const up = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'contrato-2026.pdf', 'application/pdf');
    expect(up.status).toBe(201);
    const fileId = up.body.data.fileId;

    const post = await postMessageWithFile(fixture, fixture.uidCompleta, fileId);
    expect(post.status).toBe(201);

    const res = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidCompleta);

    expect(res.status).toBe(200);
    expect(res.body.data.expiresInSeconds).toBe(300);
    expect(typeof res.body.data.url).toBe('string');
    expect(decodeURIComponent(res.body.data.url)).toContain('contrato-2026.pdf');
  });

  it('2. fileId uploadado mas AINDA NÃO anexado a mensagem nenhuma — 404 (posse exige o join até conversation_message_attachments)', async () => {
    const up = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'solto.pdf', 'application/pdf');
    const fileId = up.body.data.fileId;

    const res = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidCompleta);
    expect(res.status).toBe(404);
  });

  it('3. fileId de OUTRO paciente — 404, sem vazar que o arquivo existe (mesma mensagem de "não existe")', async () => {
    const up = await upload(fixture.app, `/api/admin/patients/${fixture.patientOutro}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'alheio.pdf', 'application/pdf');
    const fileId = up.body.data.fileId;
    const postOutro = await postMessageWithFile({ ...fixture, patient: fixture.patientOutro } as AttachmentsFixture, fixture.uidCompleta, fileId);
    expect(postOutro.status).toBe(201);

    const naoExistente = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidCompleta);
    const deOutroPaciente = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patientOutro}/conversation/files/${fileId}/url`, fixture.uidCompleta);

    expect(naoExistente.status).toBe(404);
    expect(deOutroPaciente.status).toBe(200); // controle positivo: o MESMO fileId funciona sob o paciente CERTO
    expect(naoExistente.body).toEqual({ success: false, error: 'File not found' }); // mesma mensagem genérica, nunca distingue
  });

  it('4. fileId inexistente (uuid arbitrário) — 404, mesma forma que os outros casos', async () => {
    const res = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/00000000-0000-0000-0000-000000000000/url`, fixture.uidCompleta);
    expect(res.status).toBe(404);
  });

  it('5. sem célula (patient_conversation:read) — 403', async () => {
    const up = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'sem-celula.pdf', 'application/pdf');
    const fileId = up.body.data.fileId;
    await postMessageWithFile(fixture, fixture.uidCompleta, fileId);

    const res = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidSemCelula);
    expect(res.status).toBe(403);
  });

  it('6. paciente inexistente — 404', async () => {
    const res = await chamar(fixture.app, 'GET', `/api/admin/patients/00000000-0000-0000-0000-000000000000/conversation/files/00000000-0000-0000-0000-000000000000/url`, fixture.uidCompleta);
    expect(res.status).toBe(404);
  });

  it('7. 🔒 achado do gate revisao-pr (B3): mensagem cuja ÚNICA anexação foi apagada (soft delete) — 404, mesmo o arquivo tendo sido baixável ANTES do delete (controle positivo)', async () => {
    const up = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'sera-apagada.pdf', 'application/pdf');
    const fileId = up.body.data.fileId;
    const post = await postMessageWithFile(fixture, fixture.uidCompleta, fileId);
    const messageId = post.body.data.id;

    const antes = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidCompleta);
    expect(antes.status).toBe(200); // controle positivo: baixável ANTES do delete

    const del = await chamar(fixture.app, 'DELETE', `/api/admin/patients/${fixture.patient}/conversation/messages/${messageId}`, fixture.uidCompleta);
    expect(del.status).toBe(200);

    const depois = await chamar(fixture.app, 'GET', `/api/admin/patients/${fixture.patient}/conversation/files/${fileId}/url`, fixture.uidCompleta);
    expect(depois.status).toBe(404);
  });
});
