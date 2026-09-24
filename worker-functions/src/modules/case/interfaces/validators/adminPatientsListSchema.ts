import { z } from 'zod';
import { DEPENDENCY_LEVELS } from '../../domain/enums/DependencyLevel';
import { CLINICAL_SPECIALTIES } from '../../domain/enums/ClinicalSpecialty';

/**
 * adminPatientsListSchema — validates query params for GET /api/admin/patients.
 * All params are optional. Invalid enum values produce a 400 response.
 *
 * case_number: partial numeric match (digits only, prefixo `EN` opcional — T067,
 * spec 027 Fase 6). O prefixo é só a formatação de EXIBIÇÃO do caso nativo
 * (`caseNumberFormat.ts`, case_number >= 1000) — a coluna continua INTEGER, então
 * o prefixo é removido ANTES da query (`.transform`) e "EN1234" busca igual a
 * "1234". Filtra contra o case_number efetivo:
 * COALESCE(patients.case_number, MAX(job_postings.case_number)).
 */
export const adminPatientsListSchema = z.object({
  search: z.string().optional(),
  needs_attention: z.enum(['true', 'false']).optional(),
  attention_reason: z.string().optional(),
  clinical_specialty: z.enum(CLINICAL_SPECIALTIES as [string, ...string[]]).optional(),
  dependency_level: z.enum(DEPENDENCY_LEVELS as [string, ...string[]]).optional(),
  case_number: z
    .string()
    .trim()
    .regex(/^(?:EN)?\d+$/i, { message: 'case_number must contain digits only (optional EN prefix)' })
    .transform((v) => v.replace(/^EN/i, ''))
    .optional(),
  /** País do paciente. Ausente = todos os países (comportamento atual). */
  country: z.enum(['AR', 'BR']).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000) // raised from 100 for the patient kanban board (fetches all patients grouped by status)
    .default(20),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0),
});

export type AdminPatientsListParams = z.infer<typeof adminPatientsListSchema>;
