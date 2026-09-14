/**
 * PatientPhotoProcessor — unit puro (sharp real; sem I/O de rede/banco).
 *
 * A fixture com GPS é construída aqui via `sharp().withExif()` (mesma API que o processor
 * evita usar) — prova independente de que o EXIF injetado é real antes de provar que o
 * processador o remove. Sabotagem (L1e): adicionar `.withMetadata()` no pipeline reintroduz o
 * EXIF/GPS — o teste comentado abaixo descreve o comando; não é aplicado ao arquivo de produção.
 */
import sharp from 'sharp';
import {
  PatientPhotoProcessor,
  InvalidPatientPhotoError,
  PatientPhotoTooLargeError,
  MAX_PHOTO_BYTES,
} from '../PatientPhotoProcessor';

async function jpegWithGps(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  // `sharp.Exif` só tipa `IFD0` — a lib aceita `GPS` em runtime (libvips escreve o IFD pelo
  // nome), então o bloco GPS passa por `as unknown as sharp.Exif` para o teste ter GPS real.
  return sharp(base)
    .withExif({
      IFD0: { Make: 'TestCam', Software: 'jest' },
      GPS: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 0/1',
      },
    } as unknown as sharp.Exif)
    .jpeg()
    .toBuffer();
}

describe('PatientPhotoProcessor (spec 018 PR-4, lex-pr4-foto L1e)', () => {
  const processor = new PatientPhotoProcessor();

  it('fixture tem EXIF/GPS de verdade ANTES do processamento (controle positivo)', async () => {
    const input = await jpegWithGps();
    const meta = await sharp(input).metadata();
    expect(meta.exif).toBeDefined();
    expect(meta.exif!.length).toBeGreaterThan(0);
  });

  it('re-encode remove EXIF e GPS — saída sem metadata', async () => {
    const input = await jpegWithGps();
    const result = await processor.process(input);
    expect(result.contentType).toBe('image/jpeg');
    const outMeta = await sharp(result.buffer).metadata();
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.format).toBe('jpeg');
  });

  it('re-encode de PNG também sai JPEG sem metadata', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png()
      .toBuffer();
    const result = await processor.process(png);
    expect(result.contentType).toBe('image/jpeg');
    const outMeta = await sharp(result.buffer).metadata();
    expect(outMeta.format).toBe('jpeg');
    expect(outMeta.exif).toBeUndefined();
  });

  it('redimensiona para caber em 1024px no maior lado, sem ampliar imagem pequena', async () => {
    const big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
    const result = await processor.process(big);
    const outMeta = await sharp(result.buffer).metadata();
    expect(outMeta.width).toBeLessThanOrEqual(1024);
    expect(outMeta.height).toBeLessThanOrEqual(1024);

    const small = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
    const resultSmall = await processor.process(small);
    const outMetaSmall = await sharp(resultSmall.buffer).metadata();
    expect(outMetaSmall.width).toBe(10);
    expect(outMetaSmall.height).toBe(10);
  });

  it('rejeita arquivo que não é imagem válida (422 no controller)', async () => {
    await expect(processor.process(Buffer.from('não é uma imagem'))).rejects.toThrow(InvalidPatientPhotoError);
  });

  it('rejeita formato fora de JPEG/PNG (ex.: WEBP)', async () => {
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .webp()
      .toBuffer();
    await expect(processor.process(webp)).rejects.toThrow(InvalidPatientPhotoError);
  });

  it('rejeita arquivo maior que 5 MB (413 no controller)', async () => {
    const oversized = Buffer.alloc(MAX_PHOTO_BYTES + 1, 1);
    await expect(processor.process(oversized)).rejects.toThrow(PatientPhotoTooLargeError);
  });

  // Sabotagem (documentada, não aplicada ao arquivo de produção): trocar
  // `.jpeg({ quality: 85 })` por `.withMetadata().jpeg({ quality: 85 })` em
  // PatientPhotoProcessor.ts faz este teste (linha 51) falhar — `outMeta.exif` deixa
  // de ser `undefined` porque o pipeline volta a copiar o EXIF/GPS de entrada.
});
