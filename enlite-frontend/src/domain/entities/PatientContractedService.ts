/**
 * PatientContractedService — o serviço contratado como entidade (spec 013, bloco C).
 * Mirrors `ContractedServiceDetail`/`ContractedServiceProviderDetail`
 * (worker-functions/src/modules/case/infrastructure/PatientContractedServiceRepository.ts,
 * ContractedServiceProviderRepository.ts) + a projeção por ator (contractedServiceHourlyValueAccess.ts):
 * spec 058 — pagador, preço e imposto vêm do VÍNCULO com o contrato e do termo vigente (read-only no serviço).
 *
 * Extraído para arquivo próprio (molde PatientCoverage.ts/PatientAddress.ts): PatientDetail.ts
 * já batia no teto de 400 linhas do validador.
 */

import type { Currency, PayerKind } from './InsuranceContract';

export const SERVICE_CODES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
export type ServiceCode = (typeof SERVICE_CODES)[number];

export const CARE_LOCATIONS = ['HOME', 'SCHOOL', 'INSTITUTION', 'OTHER'] as const;
export type CareLocation = (typeof CARE_LOCATIONS)[number];

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

/**
 * Franja etária SOLICITADA DO PRESTADOR para este serviço (spec 015, US-A6.1; D191/D254/D256;
 * migration 322). `null` = não informado. Ao ativar, propaga para `age_range_min/max` da vaga
 * NASCIDA DESTE SERVIÇO (backend: `ProviderAgeBandMapping.ts`, fonte única).
 */
/**
 * Spec 027 Fase 3 (D507): sexo requerido do prestador. `BOTH` = indistinto (respondido); `null` = sem responder.
 * Sem campo de motivo: o motivo é clínico e nunca se registra (D507 item 4).
 */
export const REQUIRED_SEX_OPTIONS = ['M', 'F', 'BOTH'] as const;
export type RequiredSex = (typeof REQUIRED_SEX_OPTIONS)[number];

/** Spec 027 Fase 3 (lex W.1): tipo de jornada — o vocabulário do parser da vaga. */
export const WORK_SCHEDULE_OPTIONS = ['full-time', 'part-time', 'flexible'] as const;
export type WorkSchedule = (typeof WORK_SCHEDULE_OPTIONS)[number];

/** Spec 027 Fase 3: profissões selecionáveis (as mesmas do formulário de vaga). */
export const REQUIRED_PROFESSION_OPTIONS = ['AT', 'CAREGIVER'] as const;

/** Tetos do Zod do backend (lex T.7) — espelhados para o formulário. */
export const RECRUITMENT_TEXT_MAX = 2000;
export const PAYMENT_DAY_MAX = 100;

export const PROVIDER_AGE_BANDS = ['ANY', 'AGE_20_30', 'AGE_30_45', 'AGE_45_PLUS'] as const;
export type ProviderAgeBand = (typeof PROVIDER_AGE_BANDS)[number];

/**
 * Turno do horário do encuadre (spec 056): `{dayOfWeek, startTime, durationMinutes}` — o que a API
 * aceita e persiste. `dayOfWeek`: 0 = domingo. O turno pode atravessar a meia-noite (20:00 + 720 min).
 * `null` no serviço = "ainda sem horário" (a vaga nasce sem e o operador preenche nela).
 */
export interface ContractedServiceScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
}

/** O que a API DEVOLVE: o mesmo turno com o `endTime` derivado (início + duração, módulo 24 h). */
export interface ContractedServiceScheduleSlotDetail extends ContractedServiceScheduleSlot {
  endTime: string;
}

/** Rótulo de um endereço da ficha para selects/tabelas — o mesmo fallback de `LocalizacoesCard`. */
export function patientAddressLabel(addr: { addressFormatted: string | null; addressRaw: string | null }): string {
  return addr.addressFormatted ?? addr.addressRaw ?? '—';
}

export interface PatientContractedServiceProvider {
  id: string;
  serviceId: string;
  workerId: string;
  /** Nome descriptografado (KMS) — null quando o worker não tem nome cadastrado. */
  workerName: string | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  createdAt: string;
  updatedAt: string;
}

/** A vaga viva de um serviço, como a ficha a mostra (spec 047) — allow-list: nenhum campo de dinheiro. */
export interface PatientContractedServiceLiveVacancy {
  id: string;
  caseNumber: number | null;
  caseOrdinal: number | null;
  status: string | null;
}

/** Autorização de horas do serviço; `validTo` INCLUSIVO ('YYYY-MM-DD'). */
export interface ContractedServiceAuthorization {
  id: string;
  hours: number;
  validFrom: string;
  validTo: string;
}

/** Corpo de POST .../authorizations e .../:aid/supersede. */
export interface AuthorizationWriteBody {
  hours: number;
  validFrom: string;
  validTo: string;
}

/** Nomes do pagador (catálogo). `payerKind` só chega a quem lê o container `coverage` (junto com todo o `names`). */
export interface ContractedServicePayerNames {
  providerCode: string;
  providerName: string;
  contractId: string;
  contractName: string;
  payerKind: PayerKind | null;
}

/** Pagador vigente na data `asOf` do serviço. `names: null` = o ator não lê `coverage` (redação); `isPrivate` continua visível. */
export type ContractedServicePayer =
  | { state: 'NO_CONTRACT' }
  | { state: 'LINKED'; isPrivate: boolean; validFrom: string; validTo: string | null; names: ContractedServicePayerNames | null };

/** Uma linha do histórico de vínculos (a ficha não escreve nele; só mostra). */
export interface ContractedServicePayerHistoryItem {
  linkId: string;
  isPrivate: boolean;
  validFrom: string;
  validTo: string | null;
  names: ContractedServicePayerNames | null;
}

/** Preço-hora do contrato na data `asOf`. `REDACTED` = sem `patient_contract_value:read`. */
export type ContractedServicePrice =
  | { state: 'NO_CONTRACT' }
  | { state: 'NO_TERM' }
  | { state: 'OK'; hourlyRate: number; currency: Currency }
  | { state: 'REDACTED' };

/** Imposto do termo vigente (nunca redigido). `0` = isento. */
export type ContractedServiceTax =
  | { state: 'NO_CONTRACT' }
  | { state: 'NO_TERM' }
  | { state: 'OK'; taxRatePercent: number };

/** Os 6 estados da divergência pagador × cobertura verificada (+ `REDACTED` posto só pela projeção, sem `coverage`). */
export const COVERAGE_MATCH_STATES = ['NO_PAYER', 'PRIVATE_PAYER', 'NO_COVERAGE', 'UNMAPPED_ONLY', 'MATCH', 'MISMATCH', 'REDACTED'] as const;
export type CoverageMatchState = (typeof COVERAGE_MATCH_STATES)[number];

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
  /** Autorização VIGENTE hoje (spec 056 §5.2) — dono único das horas autorizadas; `null` = sem vigente. */
  authorization: ContractedServiceAuthorization | null;
  /** Valor antigo da coluna sem vigência (só leitura, "Valor anterior, sin vigencia"); `null` = não havia. */
  legacyAuthorizedHours: number | null;
  /** Soma das faixas do horário vigente (horas/semana) — derivada pela API; o serviço não grava mais as horas semanais. */
  scheduleHours: number;
  careLocation: string | null;
  startDate: string | null;
  /** Dia de operação (`YYYY-MM-DD`) do país do serviço em que `payer`/`price`/`tax`/`coverageMatch` foram lidos — o front nunca calcula "hoje". */
  asOf: string;
  /** Pagador vigente (vínculo serviço → contrato). Serviço sem vínculo = `NO_CONTRACT`. */
  payer: ContractedServicePayer;
  payerHistory: ContractedServicePayerHistoryItem[];
  /** Preço (lex C-c.2: o que se cobra, não a remuneração do prestador) e imposto do termo vigente — SÓ exibidos. */
  price: ContractedServicePrice;
  tax: ContractedServiceTax;
  coverageMatch: { state: CoverageMatchState };
  supervisionFrequency: string | null;
  guardShift: string | null;
  /** Franja etária solicitada do prestador (spec 015) — string frouxa, molde do resto do contrato. */
  providerAgeBand: string | null;
  /**
   * Endereço do paciente onde ESTE serviço é prestado (migration 330; decisão do Gabriel 05/09:
   * "um serviço é um endereço"). Ponteiro para `patient.addresses[].id` — nada de endereço é
   * copiado. `null` = ainda não vinculado → checklist `SERVICE_ADDRESS`, ativação bloqueada.
   */
  addressId: string | null;
  /** Horário do encuadre (migration 330) — `null` = ainda sem horário. */
  schedule: ContractedServiceScheduleSlotDetail[] | null;
  /**
   * Spec 027 Fase 3 (D507/D508): o que a vaga precisa. Os 5 primeiros (profissões, sexo, experiência, jornada, dia de
   * pago) são COPIADOS para a vaga ao ativar recrutamento; `workerAttributes` e `dailyObs` são SÓ FICHA.
   */
  requiredProfessions: string[] | null;
  /** 'M' | 'F' | 'BOTH' (string frouxa, molde do contrato). `null` = sem responder. */
  requiredSex: string | null;
  requiredExperience: string | null;
  workerAttributes: string | null;
  workSchedule: string | null;
  /** Dia em que a Enlite paga o PRESTADOR (D508 b). */
  paymentDay: string | null;
  dailyObs: string | null;
  /**
   * Spec 047 (F2): vaga viva deste serviço (a mais antiga). `null` NÃO é sozinho "sem vaga": com
   * `liveVacancyRedacted` o backend sinaliza que o ator não lê vagas (`vacancy:read`).
   */
  liveVacancy: PatientContractedServiceLiveVacancy | null;
  /** `true` quando o backend redigiu `liveVacancy` para este ator (sem `vacancy:read`). */
  liveVacancyRedacted: boolean;
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
  careLocation?: CareLocation | null;
  startDate?: string | null;
  supervisionFrequency?: SupervisionFrequency | null;
  guardShift?: GuardShift | null;
  providerAgeBand?: ProviderAgeBand | null;
  addressId?: string | null;
  schedule?: ContractedServiceScheduleSlot[] | null;
  requiredProfessions?: string[] | null;
  requiredSex?: RequiredSex | null;
  requiredExperience?: string | null;
  workerAttributes?: string | null;
  workSchedule?: WorkSchedule | null;
  paymentDay?: string | null;
  dailyObs?: string | null;
  deviceTypeCodes?: string[];
}

/** Body de `PATCH .../contracted-services/:sid` — Merge Patch parcial; sem `serviceCode`. */
export type UpdateContractedServiceBody = Omit<CreateContractedServiceBody, 'serviceCode'> & {
  /** Só `false` é caminho válido (baixa) — não existe reabrir por este endpoint. */
  active?: false;
};

/** `POST …/contracted-services/:sid/contract-link` — 1º vínculo. `validTo` é inclusivo. */
export interface CreateContractLinkBody {
  contractId: string;
  validFrom: string;
  validTo?: string | null;
}

/** `POST …/contract-link/end` — encerra o vínculo vivo (só encurta). */
export interface EndContractLinkBody {
  validTo: string;
}

export type SupersedeLinkReason = 'SWITCHED' | 'CORRECTION';

/** `POST …/contract-link/supersede` — troca (`SWITCHED`, mesma obra social) ou corrige (`CORRECTION`). */
export interface SupersedeContractLinkBody extends CreateContractLinkBody {
  reason: SupersedeLinkReason;
}
