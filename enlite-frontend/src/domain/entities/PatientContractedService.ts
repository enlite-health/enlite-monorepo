/**
 * PatientContractedService — o serviço contratado como entidade (spec 013, bloco C).
 * Mirrors `ContractedServiceDetail`/`ContractedServiceProviderDetail`
 * (worker-functions/src/modules/case/infrastructure/PatientContractedServiceRepository.ts,
 * ContractedServiceProviderRepository.ts) + a redação de `hourlyValue`
 * (contractedServiceHourlyValueAccess.ts, lex C-c.4).
 *
 * Extraído para arquivo próprio (molde PatientCoverage.ts/PatientAddress.ts): PatientDetail.ts
 * já batia no teto de 400 linhas do validador.
 */

export const SERVICE_CODES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
export type ServiceCode = (typeof SERVICE_CODES)[number];

export const CARE_LOCATIONS = ['HOME', 'SCHOOL', 'INSTITUTION', 'OTHER'] as const;
export type CareLocation = (typeof CARE_LOCATIONS)[number];

export const CONTRACT_TYPES = ['OBRA_SOCIAL', 'PREPAGA', 'PRIVATE'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const TAX_CONDITIONS = ['IVA_EXEMPT', 'IVA_10_5', 'IVA_21'] as const;
export type TaxCondition = (typeof TAX_CONDITIONS)[number];

export const SUPERVISION_FREQUENCIES = ['DAYS_15', 'DAYS_30', 'DAYS_45', 'BIMONTHLY'] as const;
export type SupervisionFrequency = (typeof SUPERVISION_FREQUENCIES)[number];

export const GUARD_SHIFTS = [
  'EARLY_MORNING',
  'MORNING',
  'EARLY_AFTERNOON',
  'AFTERNOON',
  'NIGHT',
  'FULL_DAY',
] as const;
export type GuardShift = (typeof GUARD_SHIFTS)[number];

export interface PatientContractedServiceProvider {
  id: string;
  serviceId: string;
  workerId: string;
  /** Nome descriptografado (KMS) — null quando o worker não tem nome cadastrado. */
  workerName: string | null;
  weeklyHours: number | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatientContractedServiceDetail {
  id: string;
  patientId: string;
  /**
   * String, não `ServiceCode`: molde do resto do contrato (`status`, `careLocation` etc. também
   * vêm como `string` cru — ver `patientDetailContract.ts`). O formulário de EDIÇÃO usa a union
   * `ServiceCode` para restringir o que o operador pode escolher; o que a API devolve é validado
   * de forma frouxa, para não quebrar a ficha se o backend aceitar um valor novo antes do front.
   */
  serviceCode: string;
  /** Texto livre — perfil do profissional buscado. NUNCA alimenta a vaga pública (lex C-b2). */
  professionalProfile: string | null;
  providersNeeded: number | null;
  authorizedHours: number | null;
  weeklyHours: number | null;
  careLocation: string | null;
  /**
   * Preço do CONTRATO cobrado à família/obra social (lex C-c.2 — não é remuneração do
   * prestador). `null` quando o backend redigiu (ator não-admin) — ver `hourlyValueRedacted`.
   */
  hourlyValue: number | null;
  /** `true` quando o backend redigiu `hourlyValue` para este ator (lex C-c.4). */
  hourlyValueRedacted: boolean;
  version: string | null;
  startDate: string | null;
  contractType: string | null;
  taxCondition: string | null;
  supervisionFrequency: string | null;
  guardShift: string | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  deviceTypes: string[];
  providers: PatientContractedServiceProvider[];
  createdAt: string;
  updatedAt: string;
}

/** Body de `POST /patients/:id/contracted-services` (criação) — `patientId` vai na URL. */
export interface CreateContractedServiceBody {
  serviceCode: ServiceCode;
  professionalProfile?: string | null;
  providersNeeded?: number | null;
  authorizedHours?: number | null;
  weeklyHours?: number | null;
  careLocation?: CareLocation | null;
  hourlyValue?: number | null;
  version?: string | null;
  startDate?: string | null;
  contractType?: ContractType | null;
  taxCondition?: TaxCondition | null;
  supervisionFrequency?: SupervisionFrequency | null;
  guardShift?: GuardShift | null;
  deviceTypeCodes?: string[];
}

/** Body de `PATCH .../contracted-services/:sid` — Merge Patch parcial; sem `serviceCode`. */
export type UpdateContractedServiceBody = Omit<CreateContractedServiceBody, 'serviceCode'> & {
  /** Só `false` é caminho válido (baixa) — não existe reabrir por este endpoint. */
  active?: false;
};

export interface AssociateProviderBody {
  workerId: string;
  weeklyHours?: number | null;
}

export interface UpdateProviderBody {
  weeklyHours?: number | null;
  /** Só `false` (baixa) — reassociar é um novo POST. */
  active?: false;
}
