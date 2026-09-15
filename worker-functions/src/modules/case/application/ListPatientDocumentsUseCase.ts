import { PatientDocumentRepository, type PatientDocumentType } from '../infrastructure/PatientDocumentRepository';
import type { PatientDocumentContentType } from '../infrastructure/PatientDocumentStorage';

/**
 * ListPatientDocumentsUseCase — GET /patients/:id/documents (furo fechado nesta rodada: só
 * existia `POST` + `GET .../:documentId`; o front não tinha como recarregar a lista persistida).
 * Célula `patient_consent_documents:read`, checada pela ROTA (mesma da leitura individual — sem
 * criar célula nova, mesma `contracts/patient-header-and-photo.md`). SEM URL assinada aqui —
 * a URL continua exclusiva do GET por `documentId` (C10: 1 KMS/1 assinatura por abertura, nunca em
 * lote).
 */
export interface PatientDocumentListItem {
  id: string;
  documentType: PatientDocumentType;
  contentType: PatientDocumentContentType;
  sizeBytes: number;
  uploadedAt: string;
}

export class ListPatientDocumentsUseCase {
  constructor(private readonly repo: PatientDocumentRepository = new PatientDocumentRepository()) {}

  async execute(patientId: string): Promise<PatientDocumentListItem[]> {
    const rows = await this.repo.listForPatient(patientId);
    return rows
      .slice()
      .sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime())
      .map((row) => ({
        id: row.id,
        documentType: row.document_type,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        uploadedAt: row.uploaded_at,
      }));
  }
}
