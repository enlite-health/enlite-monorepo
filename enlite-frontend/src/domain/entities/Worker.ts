export interface WorkerDateStats {
  today: number;
  yesterday: number;
  sevenDaysAgo: number;
}

export interface DocumentValidationEntry {
  validatedBy: string;
  validatedAt: string; // ISO8601
}

export type DocumentValidations = Partial<Record<string, DocumentValidationEntry>>;

export interface WorkerDocument {
  id: string;
  resumeCvUrl: string | null;
  identityDocumentUrl: string | null;
  identityDocumentBackUrl: string | null;
  criminalRecordUrl: string | null;
  professionalRegistrationUrl: string | null;
  liabilityInsuranceUrl: string | null;
  monotributoCertificateUrl: string | null;
  atCertificateUrl: string | null;
  aptoPsicofisicoUrl?: string | null;
  analiticoUniversitarioUrl?: string | null;
  cartaRecomendacionUrl?: string | null;
  additionalCertificatesUrls: string[];
  documentsStatus: string;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  submittedAt: string | null;
  documentValidations?: DocumentValidations;
}

export interface WorkerServiceArea {
  id: string;
  address: string | null;
  serviceRadiusKm: number | null;
  lat: number | null;
  lng: number | null;
}

export interface WorkerLocation {
  address: string | null;
  city: string | null;
  workZone: string | null;
  interestZone: string | null;
}

export interface WorkerEncuadre {
  id: string;
  jobPostingId: string | null;
  caseNumber: number | null;
  patientName: string | null;
  resultado: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  recruiterName: string | null;
  coordinatorName: string | null;
  rejectionReason: string | null;
  rejectionReasonCategory: string | null;
  attended: boolean | null;
  createdAt: string;
}

/** Canonical profession enum (workers.profession). Mirror of backend mig 064. */
export const WORKER_PROFESSIONS = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
export type WorkerProfession = (typeof WORKER_PROFESSIONS)[number];

/** Canonical document types accepted by the admin profile edit endpoint. */
export const WORKER_DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;
export type WorkerDocumentType = (typeof WORKER_DOCUMENT_TYPES)[number];

/**
 * Partial payload for PATCH /api/admin/workers/:id/profile (admin-only).
 * Every field is optional; at least one must be sent. Address is NOT here —
 * it is edited via PUT /api/admin/workers/:id/service-area (Google Places).
 */
export interface WorkerProfileUpdatePayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  documentType?: WorkerDocumentType;
  documentNumber?: string;
  profession?: WorkerProfession;
  // Professional data
  occupation?: string;
  knowledgeLevel?: string;
  titleCertificate?: string;
  yearsExperience?: string;
  experienceTypes?: string[];
  preferredTypes?: string[];
  preferredAgeRange?: string[];
  languages?: string[];
  linkedinUrl?: string;
}

/** Canonical option value lists for worker professional fields (mirror of registration). */
// occupation foi realinhado ao enum de profession na migração 076 (CHECK idêntico).
export const WORKER_OCCUPATIONS = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
export const WORKER_KNOWLEDGE_LEVELS = ['SECONDARY', 'TERTIARY', 'TECNICATURA', 'BACHELOR', 'POSTGRADUATE', 'MASTERS', 'DOCTORATE'] as const;
export const WORKER_YEARS_EXPERIENCE = ['0_2', '3_5', '6_10', '10_plus'] as const;
export const WORKER_AGE_RANGES = ['children', 'adolescents', 'adults', 'elderly'] as const;
export const WORKER_LANGUAGES = ['pt', 'es', 'en'] as const;
export const WORKER_TRASTORNO_TYPES = [
  'adicciones', 'psicosis', 'trastorno_alimentar', 'trastorno_bipolaridad', 'trastorno_ansiedad',
  'trastorno_discapacidad_intelectual', 'trastorno_depresivo', 'trastorno_neurologico',
  'trastorno_opositor_desafiante', 'trastorno_psicologico', 'trastorno_psiquiatrico',
] as const;

export interface WorkerProfileUpdateResult {
  workerId: string;
  fieldsUpdated: string[];
}

/**
 * Payload for PUT /api/admin/workers/:id/service-area (admin-only).
 * Mirrors the worker self-service service-area save (Google Places + lat/lng).
 */
export interface WorkerServiceAreaUpdatePayload {
  address: string;
  addressComplement?: string;
  serviceRadiusKm: number;
  lat: number;
  lng: number;
  city?: string;
  postalCode?: string;
  neighborhood?: string;
}

export interface WorkerDetail {
  id: string;
  email: string;
  phone: string | null;
  whatsappPhone: string | null;
  country: string;
  timezone: string;
  status: 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED';
  overallStatus: string | null;
  availabilityStatus: string | null;
  dataSources: string[];
  platform: string;
  createdAt: string;
  updatedAt: string;

  firstName: string | null;
  lastName: string | null;
  sex: string | null;
  gender: string | null;
  birthDate: string | null;
  documentType: string | null;
  documentNumber: string | null;
  profilePhotoUrl: string | null;

  profession: string | null;
  occupation: string | null;
  knowledgeLevel: string | null;
  titleCertificate: string | null;
  experienceTypes: string[];
  yearsExperience: string | null;
  preferredTypes: string[];
  preferredAgeRange: string[];
  languages: string[];

  sexualOrientation: string | null;
  race: string | null;
  religion: string | null;
  weightKg: string | null;
  heightCm: string | null;
  hobbies: string[];
  diagnosticPreferences: string[];
  linkedinUrl: string | null;

  isMatchable: boolean;
  isActive: boolean;
  isTest: boolean;

  documents: WorkerDocument | null;
  serviceAreas: WorkerServiceArea[];
  location: WorkerLocation | null;
  encuadres: WorkerEncuadre[];
  availability?: WorkerAvailabilitySlot[];
  tags?: import('./WorkerTag').WorkerTagSummary[];
}

export interface WorkerAvailabilitySlot {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  crossesMidnight: boolean;
}
