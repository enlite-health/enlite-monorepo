/**
 * stripJpegMetadata — re-encode de UM JPEG sem EXIF/GPS/ICC, SEM redimensionar (usado pelo
 * documento de prova quando o upload é `image/jpeg`; a foto de perfil usa
 * `PatientPhotoProcessor`, que também redimensiona — a prova quer fidelidade, não miniatura).
 *
 * Mesma garantia do `PatientPhotoProcessor`: ausência de `.withMetadata()` no pipeline.
 */
import sharp from 'sharp';

export class InvalidDocumentImageError extends Error {
  constructor() {
    super('Arquivo não é um JPEG válido');
    this.name = 'InvalidDocumentImageError';
  }
}

export async function stripJpegMetadata(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (metadata.format !== 'jpeg') throw new InvalidDocumentImageError();
  } catch (err) {
    if (err instanceof InvalidDocumentImageError) throw err;
    throw new InvalidDocumentImageError();
  }
  return sharp(buffer, { failOn: 'error' }).rotate().jpeg({ quality: 92 }).toBuffer();
}
