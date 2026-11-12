/**
 * LinkExistingVacancyContract — contrato do vínculo de vaga existente ao serviço contratado
 * (spec 079, plan §3.2/§3.3/§3.5). Só tipos e constantes; nenhuma lógica.
 *
 * Os códigos do portão NÃO são redeclarados aqui: vêm de `RECRUITMENT_BLOCKING_CODES`
 * (PatientCompleteness.ts), a fonte única.
 */
import type { RECRUITMENT_BLOCKING_CODES } from './PatientCompleteness';

/** Campos que o vínculo pode alimentar no serviço. `age_range` = par min/max ↔ provider_age_band; `address` = patient_address_id ↔ address_id. */
export const LINK_FIELDS = [
  'required_professions',
  'required_experience',
  'work_schedule',
  'payment_day',
  'required_sex',
  'providers_needed',
  'age_range',
  'schedule',
  'address',
] as const;
export type LinkField = (typeof LINK_FIELDS)[number];

export const LINK_WARNING_CODES = [
  'PROVIDERS_NEEDED_NOT_INTEGER',
  'AGE_RANGE_NO_EXACT_BAND',
  'VALUE_OUTSIDE_SERVICE_DOMAIN',
] as const;
export type LinkWarningCode = (typeof LINK_WARNING_CODES)[number];

export type LinkBlockerCode = 'ADDRESS_MISMATCH' | (typeof RECRUITMENT_BLOCKING_CODES)[number];

export const VACANCY_NOT_LINKABLE_REASONS = [
  'NOT_FOUND',
  'OTHER_PATIENT',
  'ALREADY_LINKED',
  'DELETED',
  'DE_BAJA',
] as const;
export type VacancyNotLinkableReason = (typeof VACANCY_NOT_LINKABLE_REASONS)[number];

export type LinkOrigin = 'SERVICE' | 'NONE';

export interface LinkPreviewRow {
  field: LinkField;
  vacancyValue: unknown;
  effectiveValue: unknown;
  origin: LinkOrigin;
}

export interface LinkWarning {
  field: LinkField;
  code: LinkWarningCode;
}

/** Espelha `PatientVacancyRow` (PatientVacanciesQueryHelper.ts). */
export interface LinkableVacancy {
  id: string;
  caseNumber: number | null;
  caseOrdinal: number | null;
  vacancyNumber: number | null;
  title: string | null;
  status: string | null;
  isDraft: boolean;
  createdAt: Date;
}

export interface LinkPreview {
  vacancyId: string;
  rows: LinkPreviewRow[];
  warnings: LinkWarning[];
  blockers: LinkBlockerCode[];
  canConfirm: boolean;
}

export interface LinkPreviewResponse {
  candidates: LinkableVacancy[];
  preview: LinkPreview | null;
}

export interface LinkConfirmResponse {
  vacancyId: string;
  serviceId: string;
  fedFields: LinkField[];
}

/** Prefixo de `field_name` na auditoria dos campos do serviço alimentados pelo vínculo (plan §3.5). */
export const LINK_AUDIT_SERVICE_FIELD_PREFIX = 'contracted_service.';
