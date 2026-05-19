import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

registry.registerPath({
  method: 'get',
  path: '/api/admin/auth/profile',
  tags: ['Admin · Auth'],
  summary: 'Retorna perfil do admin autenticado',
  description:
    'Retorna dados do usuário interno autenticado via Firebase token: nome, e-mail e papel (role). ' +
    'Usado pelo frontend para exibir informações do usuário logado.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Perfil do admin.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
