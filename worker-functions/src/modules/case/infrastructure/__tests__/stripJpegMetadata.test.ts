import sharp from 'sharp';
import { stripJpegMetadata, InvalidDocumentImageError } from '../stripJpegMetadata';

async function jpegWithExif(): Promise<Buffer> {
  const base = await sharp({ create: { width: 20, height: 15, channels: 3, background: { r: 5, g: 6, b: 7 } } }).jpeg().toBuffer();
  return sharp(base).withExif({ IFD0: { Make: 'TestCam' } }).jpeg().toBuffer();
}

describe('stripJpegMetadata (spec 018 PR-4, lex-documentos #9)', () => {
  it('remove EXIF de um JPEG real, mantendo dimensões', async () => {
    const input = await jpegWithExif();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();

    const out = await stripJpegMetadata(input);
    const after = await sharp(out).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.format).toBe('jpeg');
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });

  it('rejeita arquivo que não é JPEG (ex.: PNG)', async () => {
    const png = await sharp({ create: { width: 5, height: 5, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    await expect(stripJpegMetadata(png)).rejects.toThrow(InvalidDocumentImageError);
  });

  it('rejeita bytes que não são imagem nenhuma', async () => {
    await expect(stripJpegMetadata(Buffer.from('not an image'))).rejects.toThrow(InvalidDocumentImageError);
  });
});
