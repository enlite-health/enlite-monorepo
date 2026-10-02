/**
 * UploadPatientDocumentUseCase — POST /patients/:id/documents (spec 031, aba "Documentos").
 *
 * Ordem (molde `UploadConversationAttachmentUseCase`): nome válido → paciente existe → pipeline de
 * validação do chat (MESMA política: 10 MB, PDF/PNG/JPEG/DOCX, 413/415 no servidor — FR-003) → sobe o
 * objeto (fora de transação) → cifra caminho/nome/rótulo (KMS) → grava a linha numa transação com o
 * contexto do ator (`withActorContext`; RLS exige a identidade carimbada).
 *
 * INSERT falhou depois do upload → o objeto novo vira órfão: apaga best-effort; se o apagar também
 * falhar, loga SÓ o código (o `message` do GCS traz o nome do objeto — nunca em log).
 */
import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { ConversationAttachmentValidator } from '@modules/conversation/infrastructure/ConversationAttachmentValidator';
import { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { AttachmentRejectedError } from '@modules/conversation/application/UploadConversationAttachmentUseCase';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';
import {
  normalizeDocumentLabel,
  PatientNotFoundError,
  type PatientDocumentDto,
} from '../domain/PatientDocument';
import { toPatientDocumentDtos } from './toPatientDocumentDtos';

export const PATIENT_DOCUMENTS_OBJECT_PREFIX = 'patient-documents';

export interface UploadPatientDocumentParams {
  patientId: string;
  actorUid: string;
  buffer: Buffer;
  originalFilename: string;
  /** Nome livre dado pela operadora (obrigatório, trim, 1–255). */
  label: unknown;
}

export class UploadPatientDocumentUseCase {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly validator: ConversationAttachmentValidator = new ConversationAttachmentValidator(),
    // Fábrica (não instância): sem `PATIENT_DOCUMENTS_BUCKET` o `new` lança — uma instância default
    // derrubaria o BOOT da API; a fábrica só roda dentro de `execute()`.
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(pool: Pool, params: UploadPatientDocumentParams): Promise<PatientDocumentDto> {
    const label = normalizeDocumentLabel(params.label);
    if (!(await this.repository.patientExists(params.patientId, pool))) throw new PatientNotFoundError();

    const validation = await this.validator.validate(params.buffer);
    if (!validation.ok) throw new AttachmentRejectedError(validation.code, validation.message);

    const storage = this.storageFactory();
    const { objectPath } = await storage.uploadBuffer(validation.buffer, validation.contentType, PATIENT_DOCUMENTS_OBJECT_PREFIX);

    let id: string;
    try {
      const [filePathEncrypted, originalNameEncrypted, labelEncrypted] = await Promise.all([
        this.enc.encrypt(objectPath),
        this.enc.encrypt(params.originalFilename),
        this.enc.encrypt(label),
      ]);
      const sha256 = createHash('sha256').update(validation.buffer).digest();

      ({ id } = await withActorContext(pool, (client) =>
        this.repository.insertTabDocument(
          {
            patientId: params.patientId,
            labelEncrypted: labelEncrypted as string,
            filePathEncrypted: filePathEncrypted as string,
            originalNameEncrypted: originalNameEncrypted as string,
            contentType: validation.contentType,
            sizeBytes: validation.buffer.byteLength,
            sha256,
            createdByUid: params.actorUid,
          },
          client,
        ),
      ));
    } catch (err) {
      await storage.delete(objectPath).catch((deleteErr: unknown) => {
        logger.warn(
          { deleteErrCode: (deleteErr as { code?: number })?.code },
          '[UploadPatientDocumentUseCase] objeto novo não apagado após falha do INSERT — vira órfão no bucket',
        );
      });
      throw err;
    }

    // Fora do try de propósito: a linha JÁ está commitada — uma falha só da releitura não pode apagar o objeto.
    const rows = await this.repository.findByPatient(params.patientId, pool, id);
    return (await toPatientDocumentDtos(rows, this.enc))[0];
  }
}
