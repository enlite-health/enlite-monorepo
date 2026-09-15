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
 * Emulador local (e2e/fake-gcs): a env própria `GCS_EMULATOR_HOST` (lida em
 * `PatientObjectStorageBase.getClient`, NÃO a `STORAGE_EMULATOR_HOST` "oficial" do SDK — conserto
 * #6 da 2ª revisão do PR-4: este comentário recomendava a env errada, que o próprio SDK lê no
 * construtor e quebra `delete()` com 405 contra o fake-gcs-server, ver cabeçalho de
 * `PatientObjectStorageBase.ts`) aponta o MESMO cliente real para `http://localhost:PORT` — não é
 * "modo mock" (não existe branch que finge sucesso sem tocar em storage nenhum); é o cliente de
 * sempre falando com um servidor GCS de verdade, só que local.
 *
 * `getClient`/`delete`/`getReadSignedUrl` vivem em `PatientObjectStorageBase` (achado de
 * duplicação com `PatientDocumentStorage` na revisão do PR-4) — aqui só o que é específico do
 * bucket de foto: nome UUID (sem nome original, sem patient_id no caminho — lex-pr4-foto #6/#9).
 */
import type { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { PatientObjectStorageBase } from './PatientObjectStorageBase';

export class PatientPhotoBucketNotConfiguredError extends Error {
  constructor() {
    super('GCS_PATIENT_PHOTOS_BUCKET não configurado — sem fallback (lex-pr4-foto #1)');
    this.name = 'PatientPhotoBucketNotConfiguredError';
  }
}

export interface PatientPhotoUploadResult {
  /** Caminho do objeto no bucket — quem chama é responsável por cifrar (KMS) antes de gravar no banco. */
  objectPath: string;
}

export class PatientPhotoStorage extends PatientObjectStorageBase {
  constructor(client?: Storage) {
    super('GCS_PATIENT_PHOTOS_BUCKET', () => new PatientPhotoBucketNotConfiguredError(), client);
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
}
