/**
 * ConversationAttachmentValidator.test.ts — spec 022, Bloco 3, T307. Pipeline de D-14, nesta
 * ORDEM: magic bytes (`file-type`) → allowlist → imagem: `sharp` re-encode (strip EXIF) → PDF:
 * recusa tokens de JS/ação → `.docx`: abre zip (`yauzl`), recusa macro → `.doc`/CFB legado: recusa
 * direta com `LEGACY_DOC_NOT_ALLOWED`.
 *
 * 7 fixtures (D-14/T307), cada uma provando uma recusa ou aceite específico — construídas em
 * memória em `beforeAll` (nenhum binário comitado): PDF limpo, PDF com `/JavaScript`, `.docx`
 * limpo, `.docx` com `word/vbaProject.bin`, `.doc` legado (CFB via pacote `cfb`, já transitivo de
 * `xlsx`), PNG com EXIF real (`sharp.withExif`), arquivo de 11 MB.
 */
import sharp from 'sharp';
import * as CFB from 'cfb';
import { buildMinimalDocx } from './__fixtures__/buildZip';
import { MAX_ATTACHMENT_BYTES } from '../ConversationAttachmentPolicy';
import { ConversationAttachmentValidator } from '../ConversationAttachmentValidator';

const MINIMAL_PDF_HEADER = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';

function buildPdf(withMaliciousToken = false): Buffer {
  const body = withMaliciousToken ? `${MINIMAL_PDF_HEADER}\n/JavaScript (app.alert(1));` : MINIMAL_PDF_HEADER;
  return Buffer.from(body, 'utf8');
}

function buildLegacyDoc(): Buffer {
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, 'WordDocument', Buffer.from('conteudo-sintetico-doc-legado'));
  return CFB.write(cfb, { type: 'buffer' }) as Buffer;
}

async function buildPngWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .withExif({ IFD0: { Make: 'Enlite-Test-Marker-GPS' } })
    .toBuffer();
}

describe('ConversationAttachmentValidator — pipeline D-14 (spec 022, Bloco 3)', () => {
  const validator = new ConversationAttachmentValidator();

  it('1. PDF limpo — aceita, contentType application/pdf', async () => {
    const result = await validator.validate(buildPdf(false));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contentType).toBe('application/pdf');
  });

  it('2. PDF com /JavaScript — recusa MALICIOUS_CONTENT_DETECTED', async () => {
    const result = await validator.validate(buildPdf(true));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALICIOUS_CONTENT_DETECTED');
  });

  it('3. .docx limpo — aceita, contentType OOXML wordprocessing', async () => {
    const result = await validator.validate(buildMinimalDocx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    }
  });

  it('4. .docx com word/vbaProject.bin — recusa MALICIOUS_CONTENT_DETECTED', async () => {
    const result = await validator.validate(buildMinimalDocx({ withMacro: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALICIOUS_CONTENT_DETECTED');
  });

  it('5. .doc legado (CFB/OLE) — recusa LEGACY_DOC_NOT_ALLOWED, mensagem ES+PT', async () => {
    const result = await validator.validate(buildLegacyDoc());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('LEGACY_DOC_NOT_ALLOWED');
      expect(result.message).toMatch(/\.doc no es aceptado/);
      expect(result.message).toMatch(/\.doc não é aceito/);
    }
  });

  it('6. PNG com EXIF real — aceita, e o BUFFER de saída perde o EXIF (strip, D-14)', async () => {
    const input = await buildPngWithExif();
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.exif).toBeDefined(); // sanidade da fixture: o EXIF de entrada existe de verdade

    const result = await validator.validate(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe('image/png');
      const outputMeta = await sharp(result.buffer).metadata();
      expect(outputMeta.exif).toBeUndefined();
    }
  });

  it('7. arquivo de 11 MB — recusa FILE_TOO_LARGE antes de qualquer detecção de tipo', async () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]);
    const result = await validator.validate(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FILE_TOO_LARGE');
  });

  it('8. bytes arbitrários (nenhum magic byte reconhecido) — recusa UNSUPPORTED_MEDIA_TYPE', async () => {
    const result = await validator.validate(Buffer.from('nao-e-nenhum-formato-conhecido-0123456789'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('9. zip genérico (não docx/pptx/xlsx) — recusa UNSUPPORTED_MEDIA_TYPE, nunca aceita como docx por engano', async () => {
    const { buildStoredZip } = await import('./__fixtures__/buildZip');
    const genericZip = buildStoredZip([{ name: 'readme.txt', content: Buffer.from('oi') }]);
    const result = await validator.validate(genericZip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('10. buffer minúsculo/truncado não derruba o validador com exceção não tratada (fail-closed, nunca 500)', async () => {
    const result = await validator.validate(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.ok).toBe(false);
  });
});
