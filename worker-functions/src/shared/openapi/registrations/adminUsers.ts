import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const CreateUserBody = z.object({
  email: z.string().email().openapi({ description: 'E-mail do novo usuário.', example: 'staff@enlite.health' }),
  displayName: z.string().optional().openapi({ description: 'Nome de exibição.', example: 'Maria Staff' }),
  department: z.string().optional().openapi({ description: 'Departamento (opcional).', example: 'Recrutamento' }),
  password: z.string().min(8).optional().openapi({ description: 'Senha inicial (gerada se omitida).', example: 'TempP@ss123' }),
});

const DeleteByEmailQuery = z.object({
  email: z.string().email().openapi({ description: 'E-mail do usuário a remover.', example: 'ex-staff@enlite.health' }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/users',
  tags: ['Admin · Users'],
  summary: 'Cria usuário interno',
  description:
    'Cria um novo usuário interno no Firebase e no banco. A conta nasce SEM grupo de permissão: ' +
    'o acesso se concede pelo painel de acessos (`/admin/access`). Exige `user_management:write`.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateUserBody } } } },
  responses: {
    201: { description: 'Usuário criado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/users',
  tags: ['Admin · Users'],
  summary: 'Lista usuários internos',
  description:
    'Retorna todos os usuários internos (admin, staff, coordinator) da plataforma. ' +
    'Requer autenticação.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de usuários internos.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/users/{id}',
  tags: ['Admin · Users'],
  summary: 'Remove usuário por ID',
  description:
    'Remove um usuário interno pelo UUID, tanto do Firebase quanto do banco. ' +
    'Operação irreversível.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Usuário removido.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Usuário não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/users/{id}/reset-password',
  tags: ['Admin · Users'],
  summary: 'Envia e-mail de reset de senha',
  description:
    'Dispara o fluxo de reset de senha do Firebase para o usuário especificado. ' +
    'O usuário receberá um link por e-mail.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'E-mail de reset enviado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Usuário não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/users/by-email',
  tags: ['Admin · Users'],
  summary: 'Remove usuário por e-mail',
  description:
    'Remove um usuário interno pelo e-mail. Equivalente ao DELETE por ID mas usando e-mail como chave.',
  security: [{ firebaseAuth: [] }],
  request: { query: DeleteByEmailQuery },
  responses: {
    200: { description: 'Usuário removido.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'E-mail inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Usuário não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
