import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';
import { JOB_RADII_KM } from '@modules/matching/application/ListJobsByRadiusForWorkerUseCase';

export const WorkerJobByRadiusItem = z.object({
  id: z.string().uuid(),
  case_number: z.number().int().nullable(),
  vacancy_number: z.number().int(),
  title: z.string().openapi({ example: 'CASO 1301' }),
  service: z.string().nullable(),
  neighborhood: z.string().nullable().openapi({ description: 'Bairro do endereço da vaga, com fallback no cadastro do paciente (mesma regra do feed público).' }),
  city: z.string().nullable(),
  state: z.string().nullable(),
  schedule: z.unknown().openapi({ description: 'Horário efetivo da vaga (serviço contratado quando há), como o banco o guarda; null quando não há.' }),
  worker_type: z.array(z.string()).openapi({ description: 'Profissões requeridas efetivas; [] quando nenhuma.' }),
  distance_km: z.number().openapi({ description: 'Distância da zona do prestador ao ponto da vaga, em km com 1 casa, calculada no servidor.' }),
  already_applied: z.boolean().openapi({ description: 'true quando o prestador já tem candidatura nesta vaga (derivado em leitura).' }),
});

const ErrorCode = (code: string) => z.object({ code: z.literal(code) });

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/jobs',
  tags: ['Worker · Vagas'],
  summary: 'Vagas a até radius_km da zona do prestador autenticado, da mais perto para a mais longe (spec 077 C-37)',
  description:
    'Identidade só pelo token (req.user.uid); nenhum header de identidade é lido. Nunca devolve o endereço exato da vaga. ' +
    'Prestador de teste vê só vagas de teste; prestador real vê as vagas do feed público.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      radius_km: z.enum(JOB_RADII_KM.map(String) as [string, ...string[]]).openapi({ description: 'Raio em km (D661).', example: '10' }),
    }),
  },
  responses: {
    200: { description: 'Vagas no raio.', content: { 'application/json': { schema: z.object({ items: z.array(WorkerJobByRadiusItem) }) } } },
    400: { description: 'Raio fora de 5/10/15/20/50/100.', content: { 'application/json': { schema: ErrorCode('INVALID_RADIUS') } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Prestador inexistente ou inativo (DISABLED).', content: { 'application/json': { schema: ErrorCode('ACCOUNT_INACTIVE') } } },
    409: { description: 'Prestador sem zona de atendimento com ponto.', content: { 'application/json': { schema: ErrorCode('NO_SERVICE_AREA') } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
