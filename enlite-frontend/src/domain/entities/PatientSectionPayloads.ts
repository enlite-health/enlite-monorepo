/**
 * Payloads do `PATCH /api/admin/patients/:id/:section` — uma seção da ficha por vez.
 *
 * Saíram de `PatientDetail.ts` em 06/09 porque aquele arquivo passou de 400 linhas, o teto do
 * `validate:lines`. O corte segue o padrão que o próprio arquivo já usava: tipo por domínio em
 * arquivo próprio, re-exportado pelo barrel — como `PatientCoverage`, `PatientLifecycle` e
 * `PatientAddress` já eram. Nenhum import de consumidor muda.
 */
import type { PatientCoverageSectionPayload } from './PatientCoverage';

/**
 * Section names accepted by PATCH /api/admin/patients/:id/:section.
 * `support-network` SAIU (spec 018, PR-1, ADR-1, SUP-37): a rota é 410 — a escrita dos
 * responsáveis passou a ser por LINHA, em `AdminPatientContactRowsApiService`.
 */
export type PatientSectionName = 'general' | 'clinical' | 'coverage' | 'service';

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

/**
 * `POST /patients/:id/responsibles` — corpo completo de UMA linha (spec 018, PR-1, ADR-1).
 * `displayOrder`/`source` SAÍRAM: o servidor fixa os dois (posição no fim, `admin_manual`) — só
 * quem cria por linha do painel usa este tipo, e ele nunca escolhe onde a linha entra na lista.
 */
export interface PatientResponsibleInput {
  firstName: string;
  lastName: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  isPrimary?: boolean;
}

/**
 * `PATCH /patients/:id/responsibles/:rid` — parcial de UMA linha (RFC 7396): chave ausente não
 * toca; `null` explícito apaga onde a coluna aceita. `isPrimary` não aceita `null` (coluna NOT NULL).
 */
export type PatientResponsiblePatch = Partial<Omit<PatientResponsibleInput, 'isPrimary'>> & { isPrimary?: boolean };

/**
 * `POST /patients/:id/professionals` — corpo completo de UMA linha (spec 018, PR-5, US-11).
 * `displayOrder`/`source`/`isTeam` SAÍRAM: o servidor fixa os três (posição no fim, `admin_manual`,
 * `false` — a entrada "equipe multidisciplinar" só existe hoje vinda do ClickUp).
 */
export interface PatientProfessionalInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  specialty?: import('./patientEnums').PatientProfessionalSpecialtyCode | null;
}

/** `PATCH /patients/:id/professionals/:pid` — parcial de UMA linha (RFC 7396). `name` não aceita `null`. */
export type PatientProfessionalPatch = Partial<PatientProfessionalInput>;

/**
 * `POST /patients/:id/external-contacts` — corpo completo de UMA linha (spec 018, PR-2, `lex` #4).
 * SEM categoria de saúde no `relation` (condição do lex), SEM documento, SEM texto livre.
 */
export interface PatientExternalContactInput {
  relation: string;
  name: string;
  phone?: string | null;
}

/** `PATCH /patients/:id/external-contacts/:xid` — parcial (RFC 7396); `phone: null` apaga (bloqueado se marcado). */
export type PatientExternalContactPatch = Partial<PatientExternalContactInput>;

/** section = 'service' — targeted service_type update. */
export interface PatientServiceSectionPayload {
  serviceType?: string[] | null;
}

export type PatientSectionPayload =
  | PatientGeneralSectionPayload
  | PatientClinicalSectionPayload
  | PatientCoverageSectionPayload
  | PatientServiceSectionPayload;
