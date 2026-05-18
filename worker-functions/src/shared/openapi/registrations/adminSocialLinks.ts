import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const GenerateSocialLinkBody = z.object({
  channel: z.enum(['facebook', 'instagram', 'whatsapp', 'linkedin', 'site']).openapi({
    description: 'Canal social para o qual gerar o link encurtado com UTM tracking.',
    example: 'instagram',
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/social-links',
  tags: ['Admin · Social Links'],
  summary: 'Gera link social encurtado para vaga',
  description:
    'Cria um short link via Short.io com UTM tracking para o canal social informado. ' +
    'Não permite gerar novamente se já existe link para o canal (retorna 409).',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: GenerateSocialLinkBody } } },
  },
  responses: {
    200: { description: 'Short link gerado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Canal inválido ou vaga sem case_number.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'Link para o canal já existe.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/social-links-stats',
  tags: ['Admin · Social Links'],
  summary: 'Retorna estatísticas de cliques dos links sociais',
  description:
    'Para cada short link da vaga, consulta o Short.io para obter o total de cliques. ' +
    'Incluí links legados sem ID (retorna clicks = 0).',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Estatísticas por canal.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
