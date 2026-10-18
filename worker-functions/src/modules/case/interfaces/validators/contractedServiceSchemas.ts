import { z } from 'zod';
import { CARE_LOCATIONS, CONTRACT_TYPES, TAX_CONDITIONS, SUPERVISION_FREQUENCIES, GUARD_SHIFTS, PROVIDER_AGE_BANDS } from '../../domain/enums/ContractedService';

const SERVICE_CODES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;

/** Teto do textarea de perfil — espelha `pcs_professional_profile_len` (migration 319). */
const PROFESSIONAL_PROFILE_MAX = 2000;

/**
 * Spec 027 Fase 3 (lex T.7): tetos dos textos livres do serviço, no molde de `PROFESSIONAL_PROFILE_MAX`.
 * `payment_day` é texto curto. Texto livre dentro da ficha do paciente: NUNCA em log (lex T.4).
 */
export const REQUIRED_EXPERIENCE_MAX = 2000;
export const WORKER_ATTRIBUTES_MAX = 2000;
export const DAILY_OBS_MAX = 2000;
export const PAYMENT_DAY_MAX = 100;
/** Lex S.1: valor fora da lista dá 400 — senão `normalizeSexValue` o trata como "aceita qualquer prestador" (falha aberta). */
export const REQUIRED_SEX_VALUES = ['M', 'F', 'BOTH'] as const;
/** Lex W.1: vocabulário de `gemini-vacancy-constants.ts`. */
export const WORK_SCHEDULE_VALUES = ['full-time', 'part-time', 'flexible'] as const;

/** Campos de recrutamento do serviço (D507/D508) — idênticos em create e update. */
const recruitmentFields = {
  requiredProfessions: z.array(z.string().min(1).max(80)).max(20).nullable().optional(),
  requiredSex: z.enum(REQUIRED_SEX_VALUES).nullable().optional(),
  requiredExperience: z.string().max(REQUIRED_EXPERIENCE_MAX).nullable().optional(),
  workerAttributes: z.string().max(WORKER_ATTRIBUTES_MAX).nullable().optional(),
  workSchedule: z.enum(WORK_SCHEDULE_VALUES).nullable().optional(),
  paymentDay: z.string().max(PAYMENT_DAY_MAX).nullable().optional(),
  dailyObs: z.string().max(DAILY_OBS_MAX).nullable().optional(),
};

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullable().optional();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Horário do serviço (spec 056, plan.md §5.1): turno = `{ dayOfWeek 0-6, startTime HH:MM, durationMinutes 1..1440 }`.
 * O fim NUNCA entra pela API (`.strict()`): é derivado (início + duração). Inicio/Fin → duração é conta só do front.
 * `null` = "ainda sem horário" (decisão do Gabriel 05/09: a vacante pode nascer sem horário).
 */
const scheduleSlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM),
    durationMinutes: z.number().int().min(1).max(1440),
  })
  .strict();

// `[]` vira `null` AQUI, na borda: "sem horário" tem UMA representação no banco (NULL), não
// duas (NULL e '[]') — o `null` que significa duas coisas já apagou dado nesta casa (D167).
const optionalSchedule = z
  .array(scheduleSlotSchema)
  .max(50)
  .nullable()
  .optional()
  .transform((a) => (Array.isArray(a) && a.length === 0 ? null : a));

/** Endereço do paciente onde o serviço é prestado (migration 330). `null` desvincula. */
const optionalAddressId = z.string().uuid().nullable().optional();

export const createContractedServiceSchema = z
  .object({
    serviceCode: z.enum(SERVICE_CODES),
    professionalProfile: z.string().max(PROFESSIONAL_PROFILE_MAX).nullable().optional(),
    providersNeeded: z.number().int().positive().nullable().optional(),
    authorizedHours: z.number().nonnegative().nullable().optional(),
    weeklyHours: z.number().nonnegative().nullable().optional(),
    careLocation: optionalEnum(CARE_LOCATIONS as unknown as [string, ...string[]]),
    hourlyValue: z.number().nonnegative().nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    contractType: optionalEnum(CONTRACT_TYPES as unknown as [string, ...string[]]),
    taxCondition: optionalEnum(TAX_CONDITIONS as unknown as [string, ...string[]]),
    supervisionFrequency: optionalEnum(SUPERVISION_FREQUENCIES as unknown as [string, ...string[]]),
    guardShift: optionalEnum(GUARD_SHIFTS as unknown as [string, ...string[]]),
    // Spec 015 (US-A6.1, D191/D254/D256): franja etária solicitada do PRESTADOR para este
    // serviço — propaga para a vaga na ativação (ProviderAgeBandMapping.ts). Fora do enum → 400
    // "Invalid body" (convenção viva do controller para TODO erro zod; 422 é só DeviceTypeUnknownError).
    providerAgeBand: optionalEnum(PROVIDER_AGE_BANDS as unknown as [string, ...string[]]),
    addressId: optionalAddressId,
    schedule: optionalSchedule,
    ...recruitmentFields,
    deviceTypeCodes: z.array(z.string()).max(10).optional(),
    // `country` NÃO entra aqui de propósito (C7): a jurisdição é do PACIENTE e nasce do trigger da
    // migration 319, que só preenche quando a coluna vem NULL — valor explícito do cliente vencia
    // o trigger e carimbava `POST {country:'BR'}` num paciente AR. É a fronteira para a qual a
    // coluna existe (RLS/célula por país): `.strict()` recusa a chave com 400.
  })
  .strict();
export type CreateContractedServiceBody = z.infer<typeof createContractedServiceSchema>;

/** PATCH: mesmos campos, sem `serviceCode` (imutável — trocar de serviço é dar baixa + criar outro) + `active`. */
export const updateContractedServiceSchema = z
  .object({
    professionalProfile: z.string().max(PROFESSIONAL_PROFILE_MAX).nullable().optional(),
    providersNeeded: z.number().int().positive().nullable().optional(),
    authorizedHours: z.number().nonnegative().nullable().optional(),
    weeklyHours: z.number().nonnegative().nullable().optional(),
    careLocation: optionalEnum(CARE_LOCATIONS as unknown as [string, ...string[]]),
    hourlyValue: z.number().nonnegative().nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    contractType: optionalEnum(CONTRACT_TYPES as unknown as [string, ...string[]]),
    taxCondition: optionalEnum(TAX_CONDITIONS as unknown as [string, ...string[]]),
    supervisionFrequency: optionalEnum(SUPERVISION_FREQUENCIES as unknown as [string, ...string[]]),
    guardShift: optionalEnum(GUARD_SHIFTS as unknown as [string, ...string[]]),
    providerAgeBand: optionalEnum(PROVIDER_AGE_BANDS as unknown as [string, ...string[]]),
    addressId: optionalAddressId,
    schedule: optionalSchedule,
    ...recruitmentFields,
    deviceTypeCodes: z.array(z.string()).max(10).optional(),
    // Só `false` é caminho de escrita válido (baixa, lex C-a.4) — reabrir não existe.
    active: z.literal(false).optional(),
  })
  .strict();
export type UpdateContractedServiceBody = z.infer<typeof updateContractedServiceSchema>;
