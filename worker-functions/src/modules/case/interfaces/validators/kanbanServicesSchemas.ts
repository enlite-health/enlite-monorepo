import { z } from 'zod';
import { adminPatientsListSchema } from './adminPatientsListSchema';

/**
 * kanbanServicesSchemas — o contrato publicado do agregado do subcard do Kanban (fase 8, Plano B,
 * DX-8.1/8.5). `kanbanServicesQuerySchema` reusa o enum `country` da listagem (mesmo filtro do
 * board, ressalva (b) de fase-8.md) — sem zod novo para o parâmetro.
 *
 * O controller NÃO valida a resposta com `kanbanServicesResponseSchema` em runtime — a régua vive
 * só no teste (`kanbanServicesResponseSchema.parse(body.data)`), a mesma forma que
 * `ListKanbanServicesUseCase` devolve. `asOf` em `YYYY-MM-DD` (nunca `Date`), a mesma regra da
 * Fase 7. `slots`/`workerId`/`applicationId` NÃO saem (minimização, DX-8.5) — por isso não têm
 * schema aqui.
 */

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const kanbanServicesQuerySchema = adminPatientsListSchema.pick({ country: true });

export const kanbanServiceSummarySchema = z.object({
  contractedServiceId: z.string().uuid(),
  serviceCode: z.string(),
  contratadas: z.object({
    weekly: z.number().nullable(),
    authorized: z.number().nullable(),
  }),
  cobertas: z.number().nonnegative(),
  liveVacancyId: z.string().uuid().nullable(),
});

export const kanbanPatientServicesSchema = z.object({
  patientId: z.string().uuid(),
  asOf: z.string().regex(ISO_DATE_REGEX),
  services: z.array(kanbanServiceSummarySchema),
});

export const kanbanServicesResponseSchema = z.object({
  patients: z.array(kanbanPatientServicesSchema),
});

export type KanbanServicesResponse = z.infer<typeof kanbanServicesResponseSchema>;
