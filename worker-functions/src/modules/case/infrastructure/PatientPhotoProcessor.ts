/**
 * PatientPhotoProcessor — re-encode da foto do paciente em JPEG SEM metadados (spec 018, PR-4,
 * `lex-pr4-foto.md` L1e/L1g: "nenhuma miniatura, cache de servidor... re-encode em memória";
 * "zero reconhecimento facial").
 *
 * `sharp` por padrão NÃO copia EXIF/ICC/IPTC/XMP do buffer de entrada para o de saída — a
 * ausência de `.withMetadata()` no pipeline é o que garante GPS/EXIF fora do arquivo re-
 * codificado. A sabotagem que prova isso (`.withMetadata()` no pipeline) é o teste
 * `PatientPhotoProcessor.test.ts`.
 */
import sharp from 'sharp';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB (contracts/patient-header-and-photo.md)
const MAX_DIMENSION = 1024; // retrato — sem miniatura à parte, um tamanho só

export class InvalidPatientPhotoError extends Error {
  constructor(reason: string) {
    super(`Imagem de foto do paciente inválida: ${reason}`);
    this.name = 'InvalidPatientPhotoError';
  }
}

export class PatientPhotoTooLargeError extends Error {
  constructor() {
    super('Foto do paciente maior que o limite (5 MB)');
    this.name = 'PatientPhotoTooLargeError';
  }
}

export interface ProcessedPatientPhoto {
  buffer: Buffer;
  contentType: 'image/jpeg';
}

export class PatientPhotoProcessor {
  /**
   * Recebe `image/jpeg` ou `image/png` (contrato), sempre devolve JPEG re-codificado sem
   * metadados, redimensionado (nunca ampliado) para no máx. `MAX_DIMENSION`px no maior lado.
   */
  async process(buffer: Buffer): Promise<ProcessedPatientPhoto> {
    if (buffer.byteLength > MAX_PHOTO_BYTES) throw new PatientPhotoTooLargeError();

    let pipeline: sharp.Sharp;
    try {
      pipeline = sharp(buffer, { failOn: 'error' });
      const metadata = await pipeline.metadata();
      if (metadata.format !== 'jpeg' && metadata.format !== 'png') {
        throw new InvalidPatientPhotoError(`formato ${String(metadata.format)} não aceito`);
      }
    } catch (err) {
      if (err instanceof InvalidPatientPhotoError) throw err;
      throw new InvalidPatientPhotoError('arquivo não é uma imagem JPEG/PNG válida');
    }

    // Sem `.withMetadata()` de propósito: é a ausência dela que garante 0 EXIF/GPS na saída.
    const out = await sharp(buffer, { failOn: 'error' })
      .rotate() // aplica a orientação EXIF ANTES de descartá-la (senão a foto sai deitada)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    return { buffer: out, contentType: 'image/jpeg' };
  }
}
