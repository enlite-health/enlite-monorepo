/**
 * PatientDetail — domain entity that mirrors PatientDetailRow from the backend.
 *
 * All date fields arrive as ISO strings over JSON (Date is serialised by
 * JSON.stringify). Consumers parse them with `new Date(value)` if needed.
 */

export interface PatientResponsibleDetail {
  id: string;
  firstName: string | null;
  lastName: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  documentType: string | null;
  documentNumber: string | null;
  isPrimary: boolean;
}

export interface AddressAvailabilityPerDay {
  dayOfWeek: number;
  coveredHours: number;
  availableRanges: Array<{ start: string; end: string }>;
}

export interface AddressAvailability {
  totalCoveredHours: number;
  maxHours: 168;
  isFull: boolean;
  perDay: AddressAvailabilityPerDay[];
  activeVacanciesCount: number;
  hasUnknownSchedule: boolean;
}

export interface PatientAddressDetail {
  id: string;
  street: string | null;
  number: string | null;
  /** Address complement (Depto, Piso, andar). Migration 157. */
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zipCode: string | null;
  fullAddress: string | null;
  // Extended fields for vacancy creation form
  lat?: number | null;
  lng?: number | null;
  isPrimary?: boolean;
  availability?: AddressAvailability;
}

export interface PatientProfessionalDetail {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  specialty: string | null;
}

export interface PatientDetail {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null; // ISO string
  documentType: string | null; // 'DNI'|'PASSPORT'|'CEDULA'|'LE_LC'|'CPF'
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null; // 'MALE'|'FEMALE'|'INTERSEX'|'UNDISCLOSED'
  phoneWhatsapp: string | null;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  clinicalSegments: string | null;
  serviceType: string[] | null;
  deviceType: string | null;
  additionalComments: string | null;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  status: string | null; // 'PENDING_ADMISSION'|'ACTIVE'|'SUSPENDED'|'DISCONTINUED'|'DISCHARGED'
  needsAttention: boolean;
  attentionReasons: string[];
  responsibles: PatientResponsibleDetail[];
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  lastCaseNumber?: number | null;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

/**
 * Body for POST /api/admin/patients — manual creation of a native patient by
 * the admission team (Fase 1 Task 2). Only firstName is required; the rest is
 * filled by the team over time. Must mirror the backend zod validator
 * (createPatientSchema) and the CreatePatientUseCase input.
 */
export interface CreatePatientPayload {
  firstName: string;
  lastName?: string;
  phoneWhatsapp?: string;
  contactEmail?: string;
  documentType?: string; // 'DNI'|'PASSPORT'|'CEDULA'|'LE_LC'|'CPF'
  documentNumber?: string;
  healthInsuranceName?: string;
  healthInsuranceMemberId?: string;
  serviceType?: string[]; // Profession[]: 'AT'|'CAREGIVER'|'NURSE'|'KINESIOLOGIST'|'PSYCHOLOGIST'
}

/** Result of a successful patient creation. */
export interface CreatePatientResult {
  id: string;
}

/** Vacancy summary returned by GET /api/admin/patients/:id/vacancies */
export interface PatientVacancySummary {
  id: string;
  caseNumber: number | null;
  vacancyNumber: number | null;
  title: string | null;
  status: string | null;
  isDraft: boolean;
  createdAt: string;
}

// ============================================================================
// Fase 2b — pipeline de ativação (edição de seções, mudança de status, ativar)
// ============================================================================

/** Section names accepted by PATCH /api/admin/patients/:id/:section. */
export type PatientSectionName = 'general' | 'clinical' | 'support-network' | 'service';

/**
 * section = 'general' — identity fields. Mirrors generalSectionSchema (backend).
 * Every field is a partial update; `null` explicitly clears a nullable column.
 */
export interface PatientGeneralSectionPayload {
  firstName?: string;
  lastName?: string | null;
  birthDate?: string | null; // yyyy-MM-dd (backend coerces to Date)
  documentType?: string | null;
  documentNumber?: string | null;
  sex?: string | null;
  phoneWhatsapp?: string | null;
  contactEmail?: string | null;
}

/** section = 'clinical' — mirrors clinicalSectionSchema (backend). */
export interface PatientClinicalSectionPayload {
  diagnosis?: string | null;
  dependencyLevel?: string | null;
  clinicalSpecialty?: string | null;
  serviceType?: string[] | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;
}

/** One responsible in the support-network replace payload. */
export interface PatientResponsibleInput {
  firstName: string;
  lastName: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  isPrimary: boolean;
  displayOrder: number;
}

/** section = 'support-network' — replaces the whole responsibles set. */
export interface PatientSupportNetworkSectionPayload {
  responsibles: PatientResponsibleInput[];
}

/** section = 'service' — targeted service_type update. */
export interface PatientServiceSectionPayload {
  serviceType?: string[] | null;
}

export type PatientSectionPayload =
  | PatientGeneralSectionPayload
  | PatientClinicalSectionPayload
  | PatientSupportNetworkSectionPayload
  | PatientServiceSectionPayload;

/** Result of PUT /api/admin/patients/:id/status. */
export interface UpdatePatientStatusResult {
  id: string;
  status: string;
}

/** Result of POST /api/admin/patients/:id/activate. */
export interface ActivatePatientResult {
  patientId: string;
  status: string; // always 'ACTIVE'
  createdVacancyIds: string[];
}

/** Row shape used by the patient kanban board (grouped by status). */
export interface PatientKanbanItem {
  id: string;
  firstName: string | null;
  lastName: string | null;
  caseNumber: number | null;
  dependencyLevel: string | null;
  status: string | null;
  // Fase 4 — rastreabilidade / SLA (aditivo; opcional para não quebrar fixtures).
  /** ISO string of when the patient entered the current status column. */
  stageEnteredAt?: string | null;
  /** How long the patient has sat in the current status, in hours. */
  hoursInStage?: number | null;
  /** True when hoursInStage crossed the configured SLA threshold. */
  slaBreached?: boolean;
  /** The SLA threshold (hours) that applies to the current status. */
  slaThresholdHours?: number | null;
}

/**
 * Fase 4 — funnel/traceability aggregate returned by
 * GET /api/admin/patients/funnel?country=&from=&to=.
 * The four headline stages plus the raw per-status counts.
 */
export interface PatientFunnelData {
  solicitantes: number;
  admision: number;
  agendadas: number;
  vacantes: number;
  byStatus: Record<string, number>;
}
