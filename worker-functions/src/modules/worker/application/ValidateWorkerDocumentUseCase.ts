import { IWorkerDocumentsRepository } from '../infrastructure/WorkerDocumentsRepository';
import { ValidateDocumentDTO, WorkerDocuments } from '../domain/WorkerDocuments';
import { DocumentType } from '../infrastructure/GCSStorageService';
import { logger } from '@shared/logging';

const VALID_DOC_TYPES: DocumentType[] = [
  'resume_cv', 'identity_document', 'identity_document_back', 'criminal_record',
  'professional_registration', 'liability_insurance',
  'monotributo_certificate', 'at_certificate',
  'apto_psicofisico', 'analitico_universitario', 'carta_recomendacion',
];

const DOC_JS_FIELD: Record<DocumentType, keyof WorkerDocuments> = {
  resume_cv: 'resumeCvUrl',
  identity_document: 'identityDocumentUrl',
  identity_document_back: 'identityDocumentBackUrl',
  criminal_record: 'criminalRecordUrl',
  professional_registration: 'professionalRegistrationUrl',
  liability_insurance: 'liabilityInsuranceUrl',
  monotributo_certificate: 'monotributoCertificateUrl',
  at_certificate: 'atCertificateUrl',
  apto_psicofisico: 'aptoPsicofisicoUrl',
  analitico_universitario: 'analiticoUniversitarioUrl',
  carta_recomendacion: 'cartaRecomendacionUrl',
};

/**
 * Validates a single document for a worker.
 * Records the admin email and timestamp in document_validations JSONB.
 * Fails if:
 *   - docType is not a valid document type slug
 *   - the worker has no documents record
 *   - the target document URL is not set (nothing to validate)
 */
export class ValidateWorkerDocumentUseCase {
  constructor(private workerDocumentsRepository: IWorkerDocumentsRepository) {}

  async execute(dto: ValidateDocumentDTO): Promise<WorkerDocuments> {
    const log = logger.child({ workerId: dto.workerId });
    log.info({ msg: '[ValidateWorkerDocumentUseCase] START', docType: dto.docType, adminEmail: dto.adminEmail });

    if (!VALID_DOC_TYPES.includes(dto.docType as DocumentType)) {
      throw new Error(
        `Invalid document type "${dto.docType}". Must be one of: ${VALID_DOC_TYPES.join(', ')}`,
      );
    }

    const existing = await this.workerDocumentsRepository.findByWorkerId(dto.workerId);
    if (!existing) {
      throw new Error(`Worker documents not found for workerId: ${dto.workerId}`);
    }

    const urlField = DOC_JS_FIELD[dto.docType as DocumentType];
    const docUrl = existing[urlField] as string | undefined;
    if (!docUrl) {
      throw new Error(
        `Cannot validate "${dto.docType}": document has not been uploaded yet`,
      );
    }

    const result = await this.workerDocumentsRepository.validateDocument(
      dto.workerId,
      dto.docType,
      dto.adminEmail,
    );

    log.info({ msg: '[ValidateWorkerDocumentUseCase] DONE', docType: dto.docType });
    return result;
  }
}
