import { registry, z } from '../registry';
import { ErrorResponseSchema, successResponseSchema } from '../schemas/common';

/**
 * `GET /api/admin/staff-directory` (spec 022, T129; `contracts/openapi-staff-directory.md`;
 * `limit`/`isOnline` — change 022-ux-mencao-e-notificacao, Rodada 2/R2-B). Molde: `adminUsers.ts`.
 *
 * Alimenta o autocomplete de menção (`<@uid>`) do chat interno — NÃO é diretório de pessoal.
 * Resposta `{ uid, displayName, isOnline }[]`, NUNCA `email`, `role` nem `last_seen_at` cru (D-06
 * — vazar campo aqui é defeito de privacidade, não detalhe; `isOnline` é o único derivado
 * exposto). O próprio requester nunca aparece na própria lista.
 */
const StaffDirectoryQuery = z.object({
  q: z.string().min(2).optional().openapi({
    description:
      'Termo de busca (nome ou e-mail). Mínimo 2 caracteres se presente — `?q=a` dá 400. '
      + 'Ausente/vazio: lista os primeiros `limit` do diretório, sem filtro (revoga D-06).',
    example: 'mar',
  }),
  limit: z.coerce.number().int().min(1).max(200).optional().openapi({
    description:
      'Máximo de entradas. Default 20. Teto 200 — usado pelo "Mostrar todos" do popup de menção '
      + '(R2-B), que lista TODOS os mencionáveis com scroll, não só os primeiros 5.',
    example: 200,
  }),
});

const StaffDirectoryEntry = z.object({
  uid: z.string().openapi({ description: 'Firebase UID do staff.', example: 'e022-staffdir-com-celula' }),
  displayName: z.string().nullable().openapi({ description: 'Nome de exibição.', example: 'Maria Staff' }),
  isOnline: z.boolean().openapi({
    description:
      'R2-B: `true` se `last_seen_at` (heartbeat de `POST /api/admin/me/presence`) está dentro dos '
      + 'últimos 5 minutos. Calculado na leitura, nunca persistido — `last_seen_at` cru nunca sai '
      + 'da resposta.',
    example: true,
  }),
});

const StaffDirectoryListResponse = successResponseSchema(
  'StaffDirectoryListResponse',
  z.array(StaffDirectoryEntry),
  'Lista de staff ativo cujo nome ou e-mail casa com `q` (ou os primeiros `limit`, sem `q`), '
  + 'ordenado por nome, sem o próprio requester. Nunca inclui e-mail, role nem last_seen_at cru.',
);

registry.registerPath({
  method: 'get',
  path: '/api/admin/staff-directory',
  tags: ['Admin · Users'],
  summary: 'Diretório de staff para autocomplete de menção',
  description:
    'Lista staff ATIVO (`account_type = \'staff\' AND is_active = true`), exceto o PRÓPRIO requester, ' +
    'cujo nome ou e-mail casa com `q` (ou os primeiros `limit`, quando `q` está ausente/vazio — revoga D-06). ' +
    'Alimenta o autocomplete de menção (`<@uid>`) do chat interno do paciente — não lista quem já tem acesso ' +
    'àquele paciente especificamente, qualquer staff ativo aparece. Exige `staff_directory:read`.',
  security: [{ firebaseAuth: [] }],
  request: { query: StaffDirectoryQuery },
  responses: {
    200: { description: 'Lista de staff (até `limit` itens, default 20, teto 200).', content: { 'application/json': { schema: StaffDirectoryListResponse } } },
    400: { description: '`q` com menos de 2 caracteres, ou `limit` fora de 1-200.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `staff_directory:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
