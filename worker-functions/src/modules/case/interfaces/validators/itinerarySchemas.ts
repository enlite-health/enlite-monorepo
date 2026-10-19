import { z } from 'zod';
import { ITINERARY_ASSIGNMENT_STATUSES } from '../../domain/ServiceCoverageCalculator';

/**
 * itinerarySchemas — o contrato publicado da leitura do itinerário (fase 7, DX-7.8).
 *
 * O controller NÃO valida a resposta com este schema em runtime — a régua vive só no teste
 * (`patientItineraryResponseSchema.parse(body.data)`), a mesma forma que `GetPatientItineraryUseCase`
 * devolve. Datas em `YYYY-MM-DD` (nunca `Date`): a comparação de vigência é textual, sem fuso.
 */

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const itineraryAssignmentStatusSchema = z.enum(ITINERARY_ASSIGNMENT_STATUSES);

export const patientItineraryAssignmentSchema = z.object({
  workerId: z.string().uuid(),
  applicationId: z.string().uuid(),
  validFrom: z.string().regex(ISO_DATE_REGEX),
  validTo: z.string().regex(ISO_DATE_REGEX).nullable(),
  status: itineraryAssignmentStatusSchema,
  // Fase 12 (DX-12.5 (6)): o id da alocação e o nome do prestador — `null` fora de vigência ou sem
  // `worker_contact:read`.
  allocationId: z.string().uuid(),
  displayName: z.string().nullable(),
});

export const patientItinerarySlotSchema = z.object({
  id: z.string().uuid(),
  weekday: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
  durationMinutes: z.number().int().min(1).max(1440),
  assignments: z.array(patientItineraryAssignmentSchema),
}).strict();

export const patientItineraryServiceSchema = z.object({
  contractedServiceId: z.string().uuid(),
  scheduleHours: z.number().nonnegative(),
  cobertas: z.number().nonnegative(),
  /** 056 §9: `null` = serviço sem vaga viva ("sin vacante"). */
  reserve: z.object({ count: z.number().int().nonnegative(), minimum: z.number().int().positive() }).nullable(),
  slots: z.array(patientItinerarySlotSchema),
}).strict();

export const patientItineraryResponseSchema = z.object({
  patientId: z.string().uuid(),
  asOf: z.string().regex(ISO_DATE_REGEX),
  services: z.array(patientItineraryServiceSchema),
  /** Fase 3 (C8): `max(assembled_at)` ISO UTC; `null` = nunca montado. Obrigatório (sem `.optional()`) — o GET sempre o devolve. */
  assembledAt: z.string().datetime().nullable(),
});

export type PatientItineraryResponse = z.infer<typeof patientItineraryResponseSchema>;

// ── GET .../itinerary/events (D445.3) ────────────────────────────────────────────────────────

/** Round-trip em `Date.UTC` (molde `itineraryWriteSchemas.ts:isRealCalendarDate`) — recusa calendário inexistente (ex.: `2026-02-31`). */
function isRealCalendarDateQuery(value: string): boolean {
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const isoDateQuerySchema = z.string().regex(ISO_DATE_REGEX).refine(isRealCalendarDateQuery, { message: 'must be a real calendar date' });

export const itineraryEventsQuerySchema = z.object({
  from: isoDateQuerySchema,
  to: isoDateQuerySchema,
  serviceId: z.string().uuid().optional(),
  workerId: z.string().uuid().optional(),
});

export type ItineraryEventsQuery = z.infer<typeof itineraryEventsQuerySchema>;
