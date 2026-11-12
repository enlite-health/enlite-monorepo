import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const MatchResultsCandidate = z.object({
  workerId: z.string().uuid(),
  workerName: z.string().describe('Redigido conforme a célula de PII do ator.'),
  workerPhone: z.string().nullable(),
  occupation: z.string().nullable(),
  workZone: z.string().nullable(),
  distanceKm: z.number().nullable().describe('PostGIS, área viva MAIS PRÓXIMA do serviço (dono único da distância exibida).'),
  lat: z.number().nullable().describe('Latitude da MESMA área que deu `distanceKm`.'),
  lng: z.number().nullable().describe('Longitude da MESMA área que deu `distanceKm`.'),
  activeCasesCount: z.number().int(),
  workerStatus: z.string().nullable(),
  documentStatus: z.string().nullable(),
  source: z.string().describe("'system' (match) | 'manual' (postulação / promoção de bloqueado)."),
  funnelStage: z.string().nullable(),
  replied: z.boolean().describe('interview_response ∈ {confirmed, declined, no_response, awaiting_reschedule, awaiting_reason}.'),
  matchScore: z.number().nullable(),
  internalNotes: z.string().nullable(),
  alreadyApplied: z.boolean(),
  messagedAt: z.string().nullable().describe('ISO; messaged_at só é gravado em envio com SUCESSO.'),
});

const MatchResultsData = z.object({
  jobPostingId: z.string().uuid(),
  lastMatchAt: z.string().nullable(),
  totalCandidates: z.number().int().describe('Pessoas distintas (não linhas), worker não desativado.'),
  service: z.object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    addressLabel: z.string().nullable(),
  }).describe('null = vacante sem endereço ou sem coordenada; nunca 0.'),
  invitedCount: z.number().int().describe('messaged_at IS NOT NULL na vacante.'),
  pendingInVacancyCount: z.number().int().describe("INVITED, messaged_at NULL, source='manual', sem resposta."),
  operationDate: z.string().describe("'YYYY-MM-DD' do dia de operação do país da vacante."),
  candidates: z.array(MatchResultsCandidate),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/match-results',
  tags: ['Admin · Matching'],
  summary: 'Retorna resultado de matching de uma vaga',
  description:
    'Uma linha por PRESTADOR (área viva mais próxima do serviço), ordenada por `distance_km ASC NULLS LAST, worker_id`. ' +
    'Inclui coordenadas da área, distância, documentos, origem, etapa, resposta e `messagedAt`; ' +
    'e a meta da vacante (`service`, `invitedCount`, `pendingInVacancyCount`, `operationDate`). ' +
    '`limit` 0..500 (default 50); `limit=0` devolve só a meta.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    query: z.object({
      limit: z.number().int().min(0).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Candidatos (um por prestador) e meta da vacante.',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), data: MatchResultsData }) } },
    },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/match',
  tags: ['Admin · Matching'],
  summary: 'Executa matching manual para uma vaga',
  description:
    'Dispara o algoritmo de matching sob demanda para a vaga especificada. ' +
    'Atualiza a lista de candidatos ranqueados e retorna o resultado imediatamente.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Matching executado. Retorna candidatos.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
