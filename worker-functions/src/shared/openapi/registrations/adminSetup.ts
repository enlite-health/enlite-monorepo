import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const AdminSetupBody = z.object({
  email: z.string().email().openapi({ description: 'E-mail do primeiro admin.', example: 'admin@enlite.health' }),
  password: z.string().min(8).openapi({ description: 'Senha inicial do admin (mínimo 8 caracteres).', example: 'S3cur3P@ss' }),
  displayName: z.string().optional().openapi({ description: 'Nome de exibição do admin.', example: 'Admin Enlite' }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/setup',
  tags: ['Admin · Setup'],
  summary: 'Cria o primeiro usuário administrador',
  description:
    'Bootstrap único — cria o admin raiz da plataforma. ' +
    'Só funciona uma vez: se já existir um admin, retorna 409. ' +
    'Não requer autenticação.',
  security: [],
  request: { body: { content: { 'application/json': { schema: AdminSetupBody } } } },
  responses: {
    201: { description: 'Admin criado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    409: { description: 'Admin já existe.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
