/**
 * GetPatientDocumentUrlUseCase — GET /patients/:id/documents/:documentId. Célula
 * `patient_consent_documents:read` (NOVA, 0 grupos ao nascer) é checada pela ROTA antes deste use
 * case — sem ela, 0 KMS e 0 assinatura (contracts/patient-header-and-photo.md, C10).
 * Legível MESMO após revogação: não filtra por consentimento vigente.
 */
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientDocumentStorage } from '../infrastructure/PatientDocumentStorage';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';

export interface PatientDocumentUrlResult {
  url: string;
  expiresInSeconds: 300;
}

export class GetPatientDocumentUrlUseCase {
  constructor(
    private readonly storage: PatientDocumentStorage = new PatientDocumentStorage(),
    private readonly repo: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(patientId: string, documentId: string): Promise<PatientDocumentUrlResult | null> {
    const row = await this.repo.findOne(patientId, documentId);
    if (!row) return null;
    const objectPath = await this.enc.decrypt(row.object_path_encrypted);
    const url = await this.storage.getReadSignedUrl(objectPath);
    return { url, expiresInSeconds: 300 };
  }
}
