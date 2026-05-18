import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

registry.registerPath({
  method: 'delete',
  path: '/api/users/me',
  tags: ['User · Account'],
  summary: 'Remove conta do usuário autenticado',
  description:
    'Soft-delete da conta do usuário autenticado via Firebase token. ' +
    'Remove dados pessoais em conformidade com LGPD. Operação irreversível.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Conta removida.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/users/{userId}',
  tags: ['User · Account'],
  summary: 'Remove conta de usuário por ID (admin)',
  description:
    'Remove a conta de qualquer usuário pelo UUID. Exclusivo para admins. ' +
    'Equivalente ao endpoint /me mas acionado por administrador.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ userId: UuidParam }) },
  responses: {
    200: { description: 'Conta removida.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão de admin.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Usuário não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
