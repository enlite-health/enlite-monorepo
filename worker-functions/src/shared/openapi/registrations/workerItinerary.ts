import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

const PatientPoint = z.object({
  lat: z.number().openapi({ description: 'Latitude na grade de ~20 m (múltiplo de 0.00018, 5 casas).' }),
  lng: z.number().openapi({ description: 'Longitude na grade de ~20 m (múltiplo de 0.00018, 5 casas).' }),
  quality: z.enum(['RELIABLE', 'UNRELIABLE']).openapi({ description: 'RELIABLE sse geocode ROOFTOP/RANGE_INTERPOLATED sem partial match.' }),
});

const ItineraryItem = z.object({
  occurrence_id: z.string().uuid().openapi({ description: 'UUID v5 de (slot_id, on_date, worker_id).' }),
  slot_id: z.string().uuid(),
  assignment_id: z.string().uuid(),
  on_date: z.string().openapi({ description: 'Data civil ISO (YYYY-MM-DD).', example: '2026-10-29' }),
  starts_at: z.string().openapi({ description: 'Instante ISO-8601.' }),
  ends_at: z.string().openapi({ description: 'Instante ISO-8601.' }),
  kind: z.enum(['REGULAR', 'SUBSTITUTION']),
  patient_first_name: z.string(),
  patient_point: PatientPoint.nullable().openapi({ description: 'Ponto degradado a ~20 m; null quando o paciente não tem lat/lng. Sem endereço em texto (P3).' }),
  country: z.string().openapi({ example: 'AR' }),
  seq: z.number().int(),
});

const ItineraryResponse = z.object({
  worker_id: z.string().uuid(),
  items: z.array(ItineraryItem),
  tombstones: z.array(z.object({})).openapi({ description: 'Sempre [] no MVP.' }),
  cursor: z.string().openapi({ description: 'Carimbo opaco.' }),
  full: z.literal(true).openapi({ description: 'Sempre true no MVP.' }),
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/itinerary',
  tags: ['Worker · Itinerário'],
  summary: 'Ocorrências de turno do worker autenticado (janela hoje−30 .. hoje+14)',
  description:
    'Identidade só pelo token (req.user.uid); nenhum header de identidade é lido. ' +
    'Worker inexistente ou inativo (DISABLED) responde 403 ACCOUNT_INACTIVE.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Itinerário do worker.', content: { 'application/json': { schema: ItineraryResponse } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: {
      description: 'Worker inativo.',
      content: { 'application/json': { schema: z.object({ code: z.literal('ACCOUNT_INACTIVE') }) } },
    },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
