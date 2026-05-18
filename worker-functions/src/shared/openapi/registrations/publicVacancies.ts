import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/vacancies/{id}',
  tags: ['Public · Vacancies'],
  summary: 'Detalhe de vaga por link público',
  description:
    'Retorna dados públicos de uma vaga acessíveis via link de divulgação. ' +
    'Não exige autenticação. Não expõe dados de PII do paciente.',
  security: [],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Dados públicos da vaga.', content: { 'application/json': { schema: OkMessage } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
