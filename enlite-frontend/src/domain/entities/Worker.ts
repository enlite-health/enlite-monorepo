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

  documents: WorkerDocument | null;
  serviceAreas: WorkerServiceArea[];
  location: WorkerLocation | null;
  encuadres: WorkerEncuadre[];
  availability?: WorkerAvailabilitySlot[];
}

export interface WorkerAvailabilitySlot {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  crossesMidnight: boolean;
}
