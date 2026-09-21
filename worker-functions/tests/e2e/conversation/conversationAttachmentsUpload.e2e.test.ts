/**
 * conversationAttachmentsUpload.e2e.test.ts — spec 022, Bloco 3 (T311/T312). HTTP real (app em
 * processo), Postgres real, GCS real (fake-gcs-server via `GCS_EMULATOR_HOST`), engine ABAC
 * LIGADO. Molde: `adminConversation.e2e.test.ts` (B1) + `patient-photo.e2e.test.ts` (upload
 * multipart contra fake-gcs real).
 *
 * Como rodar:
 *   docker run -d --name fake-gcs-022-b3 -p 54463:4443 fsouza/fake-gcs-server:1.52.2 \
 *     -scheme http -public-host localhost:54463
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *     npx jest --config jest.config.e2e.js tests/e2e/conversation/conversationAttachmentsUpload.e2e.test.ts
 */
import {
  setupAttachmentsFixture,
  teardownAttachmentsFixture,
  upload,
  chamar,
  type AttachmentsFixture,
} from './attachmentsE2eHelpers';

const PREFIX = 'b301'; // hex-safe (entra em coluna uuid do paciente) — upload
const GRUPO_NOME = `E022 B3 ${PREFIX} Completa`;

describe('POST /api/admin/patients/:id/conversation/files — upload (spec 022, Bloco 3, T311/T312)', () => {
  let fixture: AttachmentsFixture;

  beforeAll(async () => {
    fixture = await setupAttachmentsFixture(PREFIX);
  }, 30000);

  afterAll(async () => {
    await teardownAttachmentsFixture(fixture, GRUPO_NOME);
  });

  it('1. upload válido (PDF) — 201 com fileId (uuid)', async () => {
    const buffer = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, buffer, 'doc.pdf', 'application/pdf');

    expect(res.status).toBe(201);
    expect(res.body.data.fileId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. acima do limite (10 MB) — 413 FILE_TOO_LARGE, controller nunca chamado (multer barra antes)', async () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, oversized, 'grande.pdf', 'application/pdf');

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('3. tipo fora da allowlist (texto puro) — 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, Buffer.from('so texto puro, nenhum magic byte'), 'nota.txt', 'text/plain');

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('4. sem célula (patient_conversation:create) — 403, nunca chega no use case', async () => {
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidSemCelula, Buffer.from('%PDF-1.4\n%%EOF'), 'doc.pdf', 'application/pdf');

    expect(res.status).toBe(403);
  });

  it('5. paciente inexistente — 404', async () => {
    const patientInexistente = 'ee461000-b301-9999-0001-000000000001';
    const res = await upload(fixture.app, `/api/admin/patients/${patientInexistente}/conversation/files`, fixture.uidCompleta, Buffer.from('%PDF-1.4\n%%EOF'), 'doc.pdf', 'application/pdf');

    expect(res.status).toBe(404);
  });

  it('6. sem sessão (sem Authorization) — 401', async () => {
    const res = await fetch(`${fixture.app.url}/api/admin/patients/${fixture.patient}/conversation/files`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('7. sem arquivo (multipart sem campo file) — 400', async () => {
    const res = await chamar(fixture.app, 'POST', `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta);
    expect(res.status).toBe(400);
  });
});
