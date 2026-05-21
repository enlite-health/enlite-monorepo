import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

/**
 * TD-014: Schema canônico de filtros vive em
 * `modules/matching/domain/PublicJobsFilters.ts`. A registration aqui apenas
 * adiciona metadata OpenAPI por campo — manter alinhado se o domain mudar.
 *
 * Mantemos `z.object()` aqui (não importamos o schema do domain) porque
 * `.openapi()` exige Zod instance específica do `@asteasolutions/zod-to-openapi`
 * e os tipos não se chain bem em schemas com `.pipe().default()`. Custo
 * aceito: 2 lugares com lista de campos idêntica; review preventivo cobre.
 */
const PublicJobsV1QuerySchema = z.object({
  country: z.string().optional().openapi({
    description: 'Código ISO 3166-1 alpha-2 do país (default AR). Transformado para uppercase.',
    example: 'AR',
  }),
  state: z.string().optional().openapi({ description: 'Estado/província do atendimento.', example: 'Buenos Aires' }),
  city: z.string().optional().openapi({ description: 'Cidade do atendimento.', example: 'Palermo' }),
  pathology: z.string().optional().openapi({ description: 'Patologia do paciente para filtrar vagas.', example: 'TEA' }),
  worker_sex: z.enum(['FEMALE', 'MALE', 'BOTH']).optional().openapi({ description: 'Sexo do worker preferido pela família.' }),
  worker_type: z.string().optional().openapi({ description: 'Tipo de worker (AT, CUIDADOR, etc.).', example: 'AT' }),
  q: z.string().optional().openapi({ description: 'Busca textual livre no título e descrição.', example: 'acompanhante' }),
});

const PublicJobV1ItemSchema = registry.register(
  'PublicJobV1Item',
  z.object({
    id: z.string().uuid().openapi({ example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    title: z.string().openapi({ example: 'CASO 766-1' }),
    country: z.string().openapi({ example: 'AR' }),
    state: z.string().nullable().openapi({ example: 'Buenos Aires' }),
    city: z.string().nullable().openapi({ example: 'Palermo' }),
    pathology: z.string().nullable().openapi({ example: 'TEA' }),
    worker_sex: z.string().nullable().openapi({ example: 'FEMALE' }),
    worker_type: z.string().nullable().openapi({ example: 'AT' }),
    short_url: z.string().nullable().openapi({ example: 'https://enl.it/abc123' }),
  }).openapi({ description: 'Vaga pública para listagem externa (embedded widget, portal).' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/v1/jobs',
  tags: ['Public · Jobs'],
  summary: 'Lista vagas públicas ativas (v1)',
  description:
    'Endpoint público rate-limited (60 req/min) para listagem de vagas ativas. ' +
    'Cache público de 5 min (s-maxage=600). ' +
    'Usado pelo widget embed e pelo portal de empregos externo.',
  security: [],
  request: { query: PublicJobsV1QuerySchema },
  responses: {
    200: {
      description: 'Lista de vagas públicas.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(PublicJobV1ItemSchema),
          }),
        },
      },
    },
    400: { description: 'Query params inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    429: { description: 'Rate limit excedido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
