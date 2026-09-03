/**
 * Vocabulário fechado de `patient_contracted_services` (spec 013, bloco C, migration 319).
 * Espelha os CHECK constraints da migration — mudar um lado sem o outro fica só 400 legível
 * de um lado e 23514 cru do outro (mesma régua de `AdmissionStatus`/`OnHoldReason`).
 */
import type { Profession } from '../../../worker/domain/enums/Profession';

/** `service_types.code` — MESMO vocabulário de `workers.profession` (migration 318). */
export type ServiceCode = Profession;

export type CareLocation = 'HOME' | 'SCHOOL' | 'INSTITUTION' | 'OTHER';
export const CARE_LOCATIONS: readonly CareLocation[] = ['HOME', 'SCHOOL', 'INSTITUTION', 'OTHER'];

export type ContractType = 'OBRA_SOCIAL' | 'PREPAGA' | 'PRIVATE';
export const CONTRACT_TYPES: readonly ContractType[] = ['OBRA_SOCIAL', 'PREPAGA', 'PRIVATE'];

export type TaxCondition = 'IVA_EXEMPT' | 'IVA_10_5' | 'IVA_21';
export const TAX_CONDITIONS: readonly TaxCondition[] = ['IVA_EXEMPT', 'IVA_10_5', 'IVA_21'];

export type SupervisionFrequency = 'DAYS_15' | 'DAYS_30' | 'DAYS_45' | 'BIMONTHLY';
export const SUPERVISION_FREQUENCIES: readonly SupervisionFrequency[] = [
  'DAYS_15',
  'DAYS_30',
  'DAYS_45',
  'BIMONTHLY',
];

export type GuardShift =
  | 'EARLY_MORNING'
  | 'MORNING'
  | 'EARLY_AFTERNOON'
  | 'AFTERNOON'
  | 'NIGHT'
  | 'FULL_DAY';
export const GUARD_SHIFTS: readonly GuardShift[] = [
  'EARLY_MORNING',
  'MORNING',
  'EARLY_AFTERNOON',
  'AFTERNOON',
  'NIGHT',
  'FULL_DAY',
];
