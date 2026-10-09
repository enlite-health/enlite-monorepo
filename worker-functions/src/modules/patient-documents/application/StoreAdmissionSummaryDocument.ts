/**
 * StoreAdmissionSummaryDocument — grava o resumo da admissão (PDF) nos documentos do paciente (spec 049 F6).
 *
 * Mesmo caminho do `UploadPatientDocumentUseCase`: validação do pipeline do chat (magic bytes, sem JS embutido, 10 MB), objeto no
 * bucket `PATIENT_DOCUMENTS_BUCKET` sob `patient-documents/`, caminho/nome/rótulo CIFRADOS (KMS), sha256 do arquivo. Difere em
 * três pontos: a origem é `admission` com `source_appointment_id`; quem grava é o sistema (`system:admission-import`); e o trabalho
 * é em DOIS passos — `prepare` (sobe o objeto, SEM transação) e `commit` (a linha, na transação curta de quem chama, junto do
 * estado `done`). Se a transação voltar, quem chama usa `discard` para apagar o objeto.
 * Duplicata: `ON CONFLICT DO NOTHING` devolve `duplicate` — o objeto recém-subido vira órfão e é apagado (best-effort, só o código
 * do erro no log: a mensagem do GCS traz o nome do objeto).
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { ConversationAttachmentValidator } from '@modules/conversation/infrastructure/ConversationAttachmentValidator';
import { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';
import { PATIENT_DOCUMENTS_OBJECT_PREFIX } from './UploadPatientDocumentUseCase';

export const ADMISSION_IMPORT_ACTOR_UID = 'system:admission-import';

export class AdmissionSummaryRejectedError extends Error {
  readonly code = 'ADMISSION_SUMMARY_PDF_REJECTED';
  constructor(readonly rejection: string) {
    super(`admission_summary_pdf_rejected:${rejection}`);
    this.name = 'AdmissionSummaryRejectedError';
  }
}

export interface StoreAdmissionSummaryParams {
  patientId: string;
  appointmentId: string;
  pdf: Buffer;
  originalFilename: string;
  label: string;
}

export type StoreAdmissionSummaryResult = { outcome: 'stored'; documentId: string; sizeBytes: number; sha256: string } | { outcome: 'duplicate' };

/** O PDF já está no bucket (fora de transação); falta a linha. `commit` grava na transação de quem chama; `discard` apaga o objeto. */
export interface PreparedAdmissionSummary {
  commit(client: PoolClient): Promise<StoreAdmissionSummaryResult>;
  discard(): Promise<void>;
}

export class StoreAdmissionSummaryDocument {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly validator: ConversationAttachmentValidator = new ConversationAttachmentValidator(),
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  /** Passo 1, SEM transação: valida, sobe o objeto, cifra caminho/nome/rótulo. */
  async prepare(params: StoreAdmissionSummaryParams): Promise<PreparedAdmissionSummary> {
    const validation = await this.validator.validate(params.pdf);
    if (!validation.ok) throw new AdmissionSummaryRejectedError(validation.code);

    const storage = this.storageFactory();
    const { objectPath } = await storage.uploadBuffer(validation.buffer, validation.contentType, PATIENT_DOCUMENTS_OBJECT_PREFIX);
    const discard = async (): Promise<void> => {
      await storage.delete(objectPath).catch((deleteErr: unknown) => {
        logger.warn(
          { deleteErrCode: (deleteErr as { code?: number })?.code },
          '[StoreAdmissionSummaryDocument] objeto novo não apagado — vira órfão no bucket',
        );
      });
    };

    try {
      const [filePathEncrypted, originalNameEncrypted, labelEncrypted] = await Promise.all([
        this.enc.encrypt(objectPath),
        this.enc.encrypt(params.originalFilename),
        this.enc.encrypt(params.label),
      ]);
      const sha256 = createHash('sha256').update(validation.buffer).digest();
      return {
        discard,
        commit: async (client) => {
          const inserted = await this.repository.insertAdmissionDocument(
            {
              patientId: params.patientId,
              appointmentId: params.appointmentId,
              labelEncrypted: labelEncrypted as string,
              filePathEncrypted: filePathEncrypted as string,
              originalNameEncrypted: originalNameEncrypted as string,
              contentType: validation.contentType,
              sizeBytes: validation.buffer.byteLength,
              sha256,
              createdByUid: ADMISSION_IMPORT_ACTOR_UID,
            },
            client,
          );
          if (!inserted) {
            await discard();
            return { outcome: 'duplicate' } as const;
          }
          return { outcome: 'stored', documentId: inserted.id, sizeBytes: validation.buffer.byteLength, sha256: sha256.toString('hex') } as const;
        },
      };
    } catch (err) {
      await discard();
      throw err;
    }
  }
}
