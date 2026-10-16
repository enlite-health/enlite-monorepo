import { z } from 'zod';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { RECRUITMENT_TEXT_MAX, PAYMENT_DAY_MAX, type CreateContractedServiceBody } from '@domain/entities/PatientContractedService';

// Lógica de formulário dos campos de recrutamento (spec 027 Fase 3), separada do componente por `react-refresh/only-export-components`.

/** Fatia do formulário que pertence a este componente (tudo STRING/array, como os demais campos do form). */
export const recruitmentFormSchema = {
  requiredProfessions: z.array(z.string()),
  requiredSex: z.string(),
  requiredExperience: z.string().max(RECRUITMENT_TEXT_MAX),
  workerAttributes: z.string().max(RECRUITMENT_TEXT_MAX),
  workSchedule: z.string(),
  paymentDay: z.string().max(PAYMENT_DAY_MAX),
  dailyObs: z.string().max(RECRUITMENT_TEXT_MAX),
};
export type RecruitmentFormValues = { [K in keyof typeof recruitmentFormSchema]: z.infer<(typeof recruitmentFormSchema)[K]> };

export function recruitmentDefaults(service: PatientContractedServiceDetail | null): RecruitmentFormValues {
  return {
    requiredProfessions: service?.requiredProfessions ?? [],
    requiredSex: service?.requiredSex ?? '',
    requiredExperience: service?.requiredExperience ?? '',
    workerAttributes: service?.workerAttributes ?? '',
    workSchedule: service?.workSchedule ?? '',
    paymentDay: service?.paymentDay ?? '',
    dailyObs: service?.dailyObs ?? '',
  };
}

/** '' vira `null` (limpar apaga o campo); lista vazia também. Nunca loga valor (lex T.4). */
export function recruitmentBody(v: RecruitmentFormValues): Pick<
  CreateContractedServiceBody,
  'requiredProfessions' | 'requiredSex' | 'requiredExperience' | 'workerAttributes' | 'workSchedule' | 'paymentDay' | 'dailyObs'
> {
  const nz = (s: string): string | null => (s.trim() ? s.trim() : null);
  return {
    requiredProfessions: v.requiredProfessions.length > 0 ? v.requiredProfessions : null,
    requiredSex: nz(v.requiredSex) as never,
    requiredExperience: nz(v.requiredExperience),
    workerAttributes: nz(v.workerAttributes),
    workSchedule: nz(v.workSchedule) as never,
    paymentDay: nz(v.paymentDay),
    dailyObs: nz(v.dailyObs),
  };
}

