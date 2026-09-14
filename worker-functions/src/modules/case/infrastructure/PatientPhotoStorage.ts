/**
 * PatientPhotoStorage — GCS do bucket PRÓPRIO da foto de perfil do paciente (spec 018, PR-4,
 * `lex` #1; `checklists/lex-pr4-foto.md`).
 *
 * NÃO é `GCSStorageService` (worker) reaproveitado — o parecer proíbe explicitamente clonar esse
 * arquivo (`lex-pr4-documentos.md` §"NÃO clonar de worker_documents"): ele tem fallback de bucket
 * sem env, "mock mode" silencioso com delete no-op, log com `filePath`, URL de escrita 15 min no
 * navegador e leitura de 60 min. Este arquivo:
 *  - usa `@google-cloud/storage` DIRETO (não `firebase-admin.storage()`);
 *  - EXIGE `GCS_PATIENT_PHOTOS_BUCKET` — sem valor, lança (fail-closed, sem fallback de nome);
 *  - nunca gera URL de ESCRITA (upload é sempre `uploadBuffer`, pelo servidor);
 *  - URL de LEITURA é v4, 300s, emitida só depois que o CONTROLLER já checou a célula
 *    (`patient_identity:read`) — este arquivo não sabe o que é célula, só assina;
 *  - nunca loga caminho/URL — todo log daqui usa apenas o id do paciente/foto, nunca `objectPath`.
 *
 * Emulador local (e2e/fake-gcs): `STORAGE_EMULATOR_HOST` (convenção oficial do
 * `@google-cloud/storage`) aponta o MESMO cliente real para `http://localhost:PORT` — não é
 * "modo mock" (não existe branch que finge sucesso sem tocar em storage nenhum); é o cliente de
 * sempre falando com um servidor GCS de verdade, só que local.
 */
import { Storage, type Bucket } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@shared/logging';

const READ_URL_TTL_SECONDS = 300;

export class PatientPhotoBucketNotConfiguredError extends Error {
  constructor() {
    super('GCS_PATIENT_PHOTOS_BUCKET não configurado — sem fallback (lex-pr4-foto #1)');
    this.name = 'PatientPhotoBucketNotConfiguredError';
  }
}

let sharedClient: Storage | undefined;

/**
 * Cliente único por processo — reaproveita conexões.
 *
 * ⚠️ NÃO usar a env `STORAGE_EMULATOR_HOST` (achado medido em integração real contra
 * fake-gcs-server, docker, spec 018 PR-4): o `@google-cloud/storage` v7 lê essa variável no
 * PRÓPRIO construtor (`storage.js`: `const baseUrl = EMULATOR_HOST || `${apiEndpoint}/storage/v1``)
 * — se ela estiver setada no processo, TODA chamada usa a base SEM o prefixo `/storage/v1`,
 * mesmo quando este código passa `apiEndpoint` explícito. `upload`/`save` funcionam mesmo assim
 * (endpoint de upload é outro), mas `delete()` sai como `DELETE /b/<bucket>/o/<obj>` — 405 no
 * fake-gcs-server 1.52.2 (a rota do JSON API dele só existe sob `/storage/v1/`). Por isso a env
 * própria deste projeto é `GCS_EMULATOR_HOST` (nome DIFERENTE de propósito), lida aqui e passada
 * como `apiEndpoint` — o que preserva o `/storage/v1` no `baseUrl`.
 */
function getClient(): Storage {
  if (!sharedClient) {
    const emulatorHost = process.env.GCS_EMULATOR_HOST;
    sharedClient = emulatorHost
      ? new Storage({ apiEndpoint: emulatorHost, projectId: process.env.GCP_PROJECT_ID ?? 'enlite-test' })
      : new Storage(process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : undefined);
  }
  return sharedClient;
}

export interface PatientPhotoUploadResult {
  /** Caminho do objeto no bucket — quem chama é responsável por cifrar (KMS) antes de gravar no banco. */
  objectPath: string;
}

export class PatientPhotoStorage {
  private readonly bucketName: string;

  constructor(private readonly client: Storage = getClient()) {
    const bucket = process.env.GCS_PATIENT_PHOTOS_BUCKET;
    if (!bucket) throw new PatientPhotoBucketNotConfiguredError();
    this.bucketName = bucket;
  }

  private bucket(): Bucket {
    return this.client.bucket(this.bucketName);
  }

  /** Nome UUID (sem nome original, sem patient_id no caminho — lex-pr4-foto #6/#9). */
  async uploadBuffer(buffer: Buffer, contentType: 'image/jpeg'): Promise<PatientPhotoUploadResult> {
    const objectPath = `${uuidv4()}.jpg`;
    const file = this.bucket().file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: { contentType, cacheControl: 'private, max-age=0, no-store' },
    });
    return { objectPath };
  }

  /**
   * Apaga o objeto. Lança se a exclusão falhar por motivo diferente de "já não existe" — quem
   * chama decide o que fazer (grava em `patient_photo_orphans`, task 4.8/L1c).
   */
  async delete(objectPath: string): Promise<void> {
    try {
      await this.bucket().file(objectPath).delete();
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 404) return; // já não existe: sucesso do ponto de vista do chamador
      logger.warn({ err }, '[PatientPhotoStorage] falha ao apagar objeto — chamador decide órfão');
      throw err;
    }
  }

  /** URL v4 de LEITURA, 300s. Chamar só depois de checar a célula — este método não checa nada. */
  async getReadSignedUrl(objectPath: string): Promise<string> {
    const [url] = await this.bucket().file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + READ_URL_TTL_SECONDS * 1000,
    });
    return url;
  }
}
