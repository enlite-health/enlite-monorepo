/**
 * PatientDocumentStorage — GCS do bucket PRÓPRIO da prova documental (consentimento/revogação de
 * imagem; spec 018, PR-4, D329; `checklists/lex-pr4-documentos.md`).
 *
 * Mesmo desenho de `PatientPhotoStorage` (não clona `GCSStorageService`), bucket SEPARADO
 * (`GCS_PATIENT_DOCUMENTS_BUCKET`, sem fallback). Objeto sob prefixo fixo `patient-documents/`
 * (data-model.md:225) com nome UUID — nunca o nome original do arquivo, nunca `patient_id` no
 * caminho, nunca logado.
 *
 * `getClient`/`delete`/`getReadSignedUrl` vivem em `PatientObjectStorageBase` (achado de
 * duplicação com `PatientPhotoStorage` na revisão do PR-4) — aqui só o que é específico do
 * bucket de documento: prefixo `patient-documents/` + tipos de conteúdo aceitos.
 */
import type { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { PatientObjectStorageBase } from './PatientObjectStorageBase';

const OBJECT_PREFIX = 'patient-documents';

export type PatientDocumentContentType = 'application/pdf' | 'image/jpeg';

export class PatientDocumentBucketNotConfiguredError extends Error {
  constructor() {
    super('GCS_PATIENT_DOCUMENTS_BUCKET não configurado — sem fallback (lex-pr4-documentos #8/#9)');
    this.name = 'PatientDocumentBucketNotConfiguredError';
  }
}

export interface PatientDocumentUploadResult {
  objectPath: string;
}

export class PatientDocumentStorage extends PatientObjectStorageBase {
  constructor(client?: Storage) {
    super('GCS_PATIENT_DOCUMENTS_BUCKET', () => new PatientDocumentBucketNotConfiguredError(), client);
  }

  /** Sem URL assinada de ESCRITA no navegador — upload é sempre pelo servidor (lex-documentos #9). */
  async uploadBuffer(buffer: Buffer, contentType: PatientDocumentContentType): Promise<PatientDocumentUploadResult> {
    const objectPath = `${OBJECT_PREFIX}/${uuidv4()}`;
    const file = this.bucket().file(objectPath);
    await file.save(buffer, {
      resumable: false,
      metadata: { contentType, cacheControl: 'private, no-store' },
    });
    return { objectPath };
  }
}
