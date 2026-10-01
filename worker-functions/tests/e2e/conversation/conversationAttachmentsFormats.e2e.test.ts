/**
 * conversationAttachmentsFormats.e2e.test.ts — spec 022, Bloco 3 (T317; spec.md SC-005). Ponta a
 * ponta: os 4 formatos válidos (PDF, PNG, JPEG, `.docx`) sobem com 201, e os 3 formatos/conteúdos
 * inválidos citados na spec (PDF com `/JavaScript`, `.docx` com macro, `.doc` legado) são
 * recusados com 415 e NENHUMA linha nova em `stored_files`.
 *
 * Fixtures construídas em memória (mesmo padrão de `ConversationAttachmentValidator.test.ts`,
 * T307) — nenhum binário comitado.
 */
import sharp from 'sharp';
import * as CFB from 'cfb';
import { buildMinimalDocx } from '../../../src/modules/conversation/infrastructure/__tests__/__fixtures__/buildZip';
import { setupAttachmentsFixture, teardownAttachmentsFixture, upload, type AttachmentsFixture } from './attachmentsE2eHelpers';

const PREFIX = 'b303'; // hex-safe — formatos
const GRUPO_NOME = `E022 B3 ${PREFIX} Completa`;

const CLEAN_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
const MALICIOUS_PDF = Buffer.from(`${CLEAN_PDF.toString('utf8')}\n/JavaScript (app.alert(1));`);

async function pngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 4, g: 5, b: 6 } } }).jpeg().toBuffer();
}

function legacyDocBuffer(): Buffer {
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, 'WordDocument', Buffer.from('conteudo-sintetico-doc-legado'));
  return CFB.write(cfb, { type: 'buffer' }) as Buffer;
}

describe('Formatos de anexo — 4 válidos + 3 inválidos ponta a ponta (spec 022, Bloco 3, T317, SC-005)', () => {
  let fixture: AttachmentsFixture;

  beforeAll(async () => {
    fixture = await setupAttachmentsFixture(PREFIX);
  }, 30000);

  afterAll(async () => {
    await teardownAttachmentsFixture(fixture, GRUPO_NOME);
  });

  async function countStoredFiles(): Promise<number> {
    const { rows } = await fixture.pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM stored_files sf
         JOIN conversations c ON c.id = sf.conversation_id
        WHERE c.patient_id = $1`,
      [fixture.patient],
    );
    return Number(rows[0].n);
  }

  it.each([
    ['PDF limpo', CLEAN_PDF, 'doc.pdf', 'application/pdf'],
  ])('válido: %s — 201', async (_label, buffer, filename, mimetype) => {
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, buffer as Buffer, filename as string, mimetype as string);
    expect(res.status).toBe(201);
  });

  it('válido: PNG — 201', async () => {
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, await pngBuffer(), 'foto.png', 'image/png');
    expect(res.status).toBe(201);
  });

  it('válido: JPEG — 201', async () => {
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, await jpegBuffer(), 'foto.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
  });

  it('válido: .docx — 201', async () => {
    const res = await upload(
      fixture.app,
      `/api/admin/patients/${fixture.patient}/conversation/files`,
      fixture.uidCompleta,
      buildMinimalDocx(),
      'documento.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.status).toBe(201);
  });

  it('inválido: PDF com /JavaScript — 415 MALICIOUS_CONTENT_DETECTED, nenhuma linha nova em stored_files', async () => {
    const antes = await countStoredFiles();
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, MALICIOUS_PDF, 'malicioso.pdf', 'application/pdf');

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('MALICIOUS_CONTENT_DETECTED');
    expect(await countStoredFiles()).toBe(antes);
  });

  it('inválido: .docx com macro (word/vbaProject.bin) — 415 MALICIOUS_CONTENT_DETECTED, nenhuma linha nova', async () => {
    const antes = await countStoredFiles();
    const res = await upload(
      fixture.app,
      `/api/admin/patients/${fixture.patient}/conversation/files`,
      fixture.uidCompleta,
      buildMinimalDocx({ withMacro: true }),
      'com-macro.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('MALICIOUS_CONTENT_DETECTED');
    expect(await countStoredFiles()).toBe(antes);
  });

  it('inválido: .doc legado (CFB/OLE) — 415 LEGACY_DOC_NOT_ALLOWED, mensagem ES+PT, nenhuma linha nova', async () => {
    const antes = await countStoredFiles();
    const res = await upload(fixture.app, `/api/admin/patients/${fixture.patient}/conversation/files`, fixture.uidCompleta, legacyDocBuffer(), 'legado.doc', 'application/msword');

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('LEGACY_DOC_NOT_ALLOWED');
    expect(res.body.error).toMatch(/\.doc no es aceptado/);
    expect(await countStoredFiles()).toBe(antes);
  });
});
