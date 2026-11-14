import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

export const WorkerTransitRoute = z.object({
  mode: z.string().openapi({ description: 'Veículo da 1ª perna de transporte (bus, subway, train, tram).', example: 'bus' }),
  duration_min: z.number().int().openapi({ description: 'Duração total, em minutos.' }),
  steps: z
    .array(z.object({ line: z.string(), from: z.string(), to: z.string() }))
    .openapi({ description: 'Pernas de transporte em ordem (linha, parada de embarque, parada de desembarque); sem polilinha nem coordenada.' }),
});

const ErrorCode = (code: string) => z.object({ code: z.literal(code) });

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/patients/{patientRef}/transit',
  tags: ['Worker · Itinerário'],
  summary: "'Cómo llegar': transporte público da zona do prestador até o paciente (spec 077 FR-46, D659)",
  description:
    'Identidade só pelo token (req.user.uid); nenhum header de identidade é lido. Origem = zona de atendimento viva mais recente ' +
    '(nunca o GPS); destino = o paciente só quando o itinerário dele tem endereço (ocorrência em [hoje, hoje+7] com alocação ACTIVE). ' +
    'Sem zona ou sem endereço nenhuma chamada ao Google é feita.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ patientRef: z.string().uuid().openapi({ description: 'patient_ref opaco do item do itinerário.' }) }) },
  responses: {
    200: {
      description: 'Rotas (até 3); routes [] quando não há trajeto ou o paciente não tem ponto.',
      content: { 'application/json': { schema: z.object({ origin_label: z.string().openapi({ description: 'Endereço da zona; a tela mostra "Desde tu zona:" seguido dele.' }), routes: z.array(WorkerTransitRoute) }) } },
    },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Prestador inexistente ou inativo (DISABLED).', content: { 'application/json': { schema: ErrorCode('ACCOUNT_INACTIVE') } } },
    404: { description: 'Paciente sem endereço disponível para este prestador (fora de [hoje, hoje+7] ou não alocado).', content: { 'application/json': { schema: ErrorCode('ADDRESS_NOT_AVAILABLE') } } },
    409: { description: 'Prestador sem zona de atendimento com ponto.', content: { 'application/json': { schema: ErrorCode('NO_SERVICE_AREA') } } },
    429: { description: '30 consultas por hora por prestador.', content: { 'application/json': { schema: ErrorCode('RATE_LIMITED') } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
