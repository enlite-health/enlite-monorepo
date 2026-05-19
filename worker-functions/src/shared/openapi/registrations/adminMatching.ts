import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/match-results',
  tags: ['Admin · Matching'],
  summary: 'Retorna resultado de matching de uma vaga',
  description:
    'Retorna os candidatos ranqueados pelo algoritmo de matching para a vaga especificada. ' +
    'Inclui score, distância e status de documentação de cada candidato.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Candidatos ranqueados.', content: { 'application/json': { schema: OkMessage } } },
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
