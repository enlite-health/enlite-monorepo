import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const CreateUserBody = z.object({
  email: z.string().email().openapi({ description: 'E-mail do novo usuário.', example: 'staff@enlite.health' }),
  displayName: z.string().optional().openapi({ description: 'Nome de exibição.', example: 'Maria Staff' }),
  role: z.enum(['admin', 'staff', 'coordinator']).openapi({ description: 'Papel do usuário na plataforma.', example: 'staff' }),
  password: z.string().min(8).optional().openapi({ description: 'Senha inicial (gerada se omitida).', example: 'TempP@ss123' }),
});

const PatchRoleBody = z.object({
  role: z.enum(['admin', 'staff', 'coordinator']).openapi({ description: 'Novo papel do usuário.', example: 'coordinator' }),
});

const DeleteByEmailQuery = z.object({
  email: z.string().email().openapi({ description: 'E-mail do usuário a remover.', example: 'ex-staff@enlite.health' }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/users',
  tags: ['Admin · Users'],
  summary: 'Cria usuário admin/staff/coordinator',
  description:
    'Cria um novo usuário interno (admin, staff ou coordinator) no Firebase e no banco. ' +
    'Requer autenticação com perfil admin.',
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
  method: 'patch',
  path: '/api/admin/users/{id}/role',
  tags: ['Admin · Users'],
  summary: 'Altera papel do usuário',
  description:
    'Atualiza o papel (role) de um usuário interno. ' +
    'Requer permissão de admin. A alteração tem efeito imediato nas chamadas subsequentes.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: PatchRoleBody } } },
  },
  responses: {
    200: { description: 'Papel atualizado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Role inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem permissão.', content: { 'application/json': { schema: ErrorResponseSchema } } },
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
