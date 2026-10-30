/**
 * Vínculo de vaga existente ao serviço contratado (spec 079) — espelha
 * `worker-functions/src/modules/case/domain/LinkExistingVacancyContract.ts`.
 * Só tipos: o front não filtra elegibilidade nem decide o portão (quem decide é o backend).
 * `createdAt` (Date no backend) chega como string ISO no JSON.
 */
import type { RECRUITMENT_BLOCKING_CODES } from './PatientCompleteness';

export type LinkField =
  | 'required_professions'
  | 'required_experience'
  | 'work_schedule'
  | 'payment_day'
  | 'required_sex'
  | 'providers_needed'
  | 'age_range'
  | 'schedule'
  | 'address';

export type LinkWarningCode =
  | 'PROVIDERS_NEEDED_NOT_INTEGER'
  | 'AGE_RANGE_NO_EXACT_BAND'
  | 'VALUE_OUTSIDE_SERVICE_DOMAIN';

/** Códigos do portão reusados de `RECRUITMENT_BLOCKING_CODES` (fonte única no front, espelho do backend). */
export type LinkBlockerCode = 'ADDRESS_MISMATCH' | (typeof RECRUITMENT_BLOCKING_CODES)[number];

export type VacancyNotLinkableReason = 'NOT_FOUND' | 'OTHER_PATIENT' | 'ALREADY_LINKED' | 'DELETED' | 'DE_BAJA';

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

export interface LinkableVacancy {
  id: string;
  caseNumber: number | null;
  caseOrdinal: number | null;
  vacancyNumber: number | null;
  title: string | null;
  status: string | null;
  isDraft: boolean;
  createdAt: string;
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

/** `code` dos erros 409/422 dos dois endpoints (lido em `ContractedServiceApiError.code`). */
export type LinkExistingVacancyErrorCode =
  | 'SERVICE_ALREADY_RECRUITING'
  | 'VACANCY_NOT_LINKABLE'
  | 'LINK_BLOCKED'
  | 'ADDRESS_NOT_OF_PATIENT';
