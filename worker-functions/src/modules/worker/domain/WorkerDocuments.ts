export type DocumentType =
  | 'resume_cv'
  | 'identity_document'
  | 'identity_document_back'
  | 'criminal_record'
  | 'professional_registration'
  | 'liability_insurance'
  | 'monotributo_certificate'
  | 'at_certificate'
  | 'apto_psicofisico'
  | 'analitico_universitario'
  | 'carta_recomendacion';

export interface DocumentValidationEntry {
  validatedBy: string;
  validatedAt: string; // ISO8601
}

export type DocumentValidations = Partial<Record<DocumentType, DocumentValidationEntry>>;

export interface WorkerDocuments {
  id: string;
  workerId: string;

  // Document URLs (stored in Cloud Storage)
  resumeCvUrl?: string;
  identityDocumentUrl?: string;
  identityDocumentBackUrl?: string;
  criminalRecordUrl?: string;
  professionalRegistrationUrl?: string;
  liabilityInsuranceUrl?: string;
  monotributoCertificateUrl?: string;
  atCertificateUrl?: string;

  // New optional document columns (migration 207)
  aptoPsicofisicoUrl?: string;
  analiticoUniversitarioUrl?: string;
  cartaRecomendacionUrl?: string;

  // Additional certificates (legacy — migrated to worker_additional_documents)
  additionalCertificatesUrls: string[];

  // Document status
  documentsStatus: DocumentsStatus;

  // Per-document validation map
  documentValidations: DocumentValidations;

  // Review feedback
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;

  // Submission tracking
  submittedAt?: Date;
  resubmittedAt?: Date;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentsStatus = 
  | 'pending'       // Worker hasn't submitted documents yet
  | 'incomplete'    // Some documents are missing
  | 'submitted'     // All documents submitted, awaiting review
  | 'under_review'  // Being reviewed by admin
  | 'approved'      // ✅ Approved - worker can apply to jobs
  | 'rejected';     // ❌ Rejected - needs to resubmit

export interface CreateWorkerDocumentsDTO {
  workerId: string;
  resumeCvUrl?: string;
  identityDocumentUrl?: string;
  identityDocumentBackUrl?: string;
  criminalRecordUrl?: string;
  professionalRegistrationUrl?: string;
  liabilityInsuranceUrl?: string;
  monotributoCertificateUrl?: string;
  atCertificateUrl?: string;
  aptoPsicofisicoUrl?: string;
  analiticoUniversitarioUrl?: string;
  cartaRecomendacionUrl?: string;
  additionalCertificatesUrls?: string[];
}

export interface UpdateWorkerDocumentsDTO {
  workerId: string;
  resumeCvUrl?: string;
  identityDocumentUrl?: string;
  identityDocumentBackUrl?: string;
  criminalRecordUrl?: string;
  professionalRegistrationUrl?: string;
  liabilityInsuranceUrl?: string;
  monotributoCertificateUrl?: string;
  atCertificateUrl?: string;
  aptoPsicofisicoUrl?: string;
  analiticoUniversitarioUrl?: string;
  cartaRecomendacionUrl?: string;
  additionalCertificatesUrls?: string[];
  documentsStatus?: DocumentsStatus;
}

export interface WorkerAdditionalDocument {
  id: string;
  workerId: string;
  label: string;
  filePath: string;
  uploadedAt: Date;
  createdAt: Date;
}

export interface CreateAdditionalDocumentDTO {
  workerId: string;
  label: string;
  filePath: string;
}

export interface ReviewWorkerDocumentsDTO {
  workerId: string;
  documentsStatus: 'approved' | 'rejected';
  reviewNotes?: string;
  reviewedBy: string;
}

export interface ValidateDocumentDTO {
  workerId: string;
  docType: string;
  adminEmail: string;
}
