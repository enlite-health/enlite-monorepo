/**
 * Payloads do `PATCH /api/admin/patients/:id/:section` — uma seção da ficha por vez.
 *
 * Saíram de `PatientDetail.ts` em 06/09 porque aquele arquivo passou de 400 linhas, o teto do
 * `validate:lines`. O corte segue o padrão que o próprio arquivo já usava: tipo por domínio em
 * arquivo próprio, re-exportado pelo barrel — como `PatientCoverage`, `PatientLifecycle` e
 * `PatientAddress` já eram. Nenhum import de consumidor muda.
 */
import type { PatientCoverageSectionPayload } from './PatientCoverage';

/** Section names accepted by PATCH /api/admin/patients/:id/:section. */
export type PatientSectionName = 'general' | 'clinical' | 'coverage' | 'support-network' | 'service';

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
  /** US-B9 (spec 012): yyyy-MM-dd; null limpa. */
  serviceStartDate?: string | null;
}

/** section = 'clinical' — mirrors clinicalSectionSchema (backend). */
export interface PatientClinicalSectionPayload {
  diagnosis?: string | null;
  dependencyLevel?: string | null;
  // F6: `clinicalSpecialty` REMOVIDA — o `clinicalSectionSchema` `.strict()` do backend já não a
  // aceita, e nenhum chamador a usava. Chave morta num payload é 400 latente, não enfeite.
  serviceType?: string[] | null;
  /** US-B4 (spec 012): códigos de `device_types` — substitui o texto livre `deviceType`. */
  deviceTypes?: string[];
  additionalComments?: string | null;
  emergencyInstructions?: string | null;
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
  /** Procedência da linha — reenviada do detalhe; linha nova do painel = 'admin_manual'. */
  source?: string;
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
  | PatientCoverageSectionPayload
  | PatientSupportNetworkSectionPayload
  | PatientServiceSectionPayload;
