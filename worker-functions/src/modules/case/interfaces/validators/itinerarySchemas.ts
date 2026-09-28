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
  active: z.boolean(),
  assignments: z.array(patientItineraryAssignmentSchema),
});

export const patientItineraryServiceSchema = z.object({
  contractedServiceId: z.string().uuid(),
  contratadas: z.object({
    weekly: z.number().nullable(),
    authorized: z.number().nullable(),
  }),
  cobertas: z.number().nonnegative(),
  slots: z.array(patientItinerarySlotSchema),
});

export const patientItineraryResponseSchema = z.object({
  patientId: z.string().uuid(),
  asOf: z.string().regex(ISO_DATE_REGEX),
  services: z.array(patientItineraryServiceSchema),
});

export type PatientItineraryResponse = z.infer<typeof patientItineraryResponseSchema>;
