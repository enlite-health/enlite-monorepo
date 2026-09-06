import { z } from 'zod';
import { CARE_LOCATIONS, CONTRACT_TYPES, TAX_CONDITIONS, SUPERVISION_FREQUENCIES, GUARD_SHIFTS, PROVIDER_AGE_BANDS } from '../../domain/enums/ContractedService';

const SERVICE_CODES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;

/** Teto do textarea de perfil — espelha `pcs_professional_profile_len` (migration 319). */
const PROFESSIONAL_PROFILE_MAX = 2000;

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullable().optional();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Horário do encuadre (migration 330) — o MESMO slot que o form da vaga persiste em
 * `job_postings.schedule` (`scheduleToJsonb`): `{ dayOfWeek 0-6, startTime, endTime }` em HH:MM.
 * `null` = "ainda sem horário" (decisão do Gabriel 05/09: a vacante pode nascer sem horário).
 */
const scheduleSlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM),
    endTime: z.string().regex(HHMM),
  })
  .strict()
  .refine((s) => s.startTime < s.endTime, { message: 'startTime must be before endTime' });

const optionalSchedule = z.array(scheduleSlotSchema).max(50).nullable().optional();

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
    version: z.string().max(60).nullable().optional(),
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
    version: z.string().max(60).nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    contractType: optionalEnum(CONTRACT_TYPES as unknown as [string, ...string[]]),
    taxCondition: optionalEnum(TAX_CONDITIONS as unknown as [string, ...string[]]),
    supervisionFrequency: optionalEnum(SUPERVISION_FREQUENCIES as unknown as [string, ...string[]]),
    guardShift: optionalEnum(GUARD_SHIFTS as unknown as [string, ...string[]]),
    providerAgeBand: optionalEnum(PROVIDER_AGE_BANDS as unknown as [string, ...string[]]),
    addressId: optionalAddressId,
    schedule: optionalSchedule,
    deviceTypeCodes: z.array(z.string()).max(10).optional(),
    // Só `false` é caminho de escrita válido (baixa, lex C-a.4) — reabrir não existe.
    active: z.literal(false).optional(),
  })
  .strict();
export type UpdateContractedServiceBody = z.infer<typeof updateContractedServiceSchema>;

export const associateProviderSchema = z
  .object({
    workerId: z.string().uuid(),
    weeklyHours: z.number().nonnegative().nullable().optional(),
  })
  .strict();
export type AssociateProviderBody = z.infer<typeof associateProviderSchema>;

export const updateProviderSchema = z
  .object({
    weeklyHours: z.number().nonnegative().nullable().optional(),
    // Só `false` (baixa, lex C-e.2) — reassociar cria linha nova via POST.
    active: z.literal(false).optional(),
  })
  .strict();
export type UpdateProviderBody = z.infer<typeof updateProviderSchema>;
