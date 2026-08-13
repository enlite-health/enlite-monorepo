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
    'Bootstrap único — cria o admin raiz da plataforma. Não requer autenticação, ' +
    'mas exige opt-in por env (ADMIN_SETUP_ENABLED=true) e só funciona enquanto ' +
    'não existir nenhum admin: depois disso retorna 403.',
  security: [],
  request: { body: { content: { 'application/json': { schema: AdminSetupBody } } } },
  responses: {
    201: { description: 'Admin criado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Setup desabilitado (ADMIN_SETUP_ENABLED ausente/false) ou já concluído (admin existe).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
