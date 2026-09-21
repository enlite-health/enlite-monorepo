import { registry, z } from '../registry';
import { ErrorResponseSchema, successResponseSchema } from '../schemas/common';

/**
 * `GET /api/admin/staff-directory` (spec 022, T129; `contracts/openapi-staff-directory.md`).
 * Molde: `adminUsers.ts`.
 *
 * Alimenta o autocomplete de menção (`<@uid>`) do chat interno — NÃO é diretório de pessoal.
 * Resposta `{ uid, displayName }[]`, NUNCA `email` nem `role` (D-06 — vazar campo aqui é defeito
 * de privacidade, não detalhe).
 */
const StaffDirectoryQuery = z.object({
  q: z.string().min(2).openapi({
    description: 'Termo de busca (nome ou e-mail). Mínimo 2 caracteres — abaixo disso, 400.',
    example: 'mar',
  }),
});

const StaffDirectoryEntry = z.object({
  uid: z.string().openapi({ description: 'Firebase UID do staff.', example: 'e022-staffdir-com-celula' }),
  displayName: z.string().nullable().openapi({ description: 'Nome de exibição.', example: 'Maria Staff' }),
});

const StaffDirectoryListResponse = successResponseSchema(
  'StaffDirectoryListResponse',
  z.array(StaffDirectoryEntry),
  'Lista de staff ativo cujo nome ou e-mail casa com `q` (máx. 20, ordenado por nome). Nunca inclui e-mail nem role.',
);

registry.registerPath({
  method: 'get',
  path: '/api/admin/staff-directory',
  tags: ['Admin · Users'],
  summary: 'Diretório de staff para autocomplete de menção',
  description:
    'Lista staff ATIVO (`account_type = \'staff\' AND is_active = true`) cujo nome ou e-mail casa com `q`. ' +
    'Alimenta o autocomplete de menção (`<@uid>`) do chat interno do paciente — não lista quem já tem acesso ' +
    'àquele paciente especificamente, qualquer staff ativo aparece. Exige `staff_directory:read`.',
  security: [{ firebaseAuth: [] }],
  request: { query: StaffDirectoryQuery },
  responses: {
    200: { description: 'Lista de staff (até 20 itens).', content: { 'application/json': { schema: StaffDirectoryListResponse } } },
    400: { description: '`q` com menos de 2 caracteres.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `staff_directory:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
