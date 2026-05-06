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
