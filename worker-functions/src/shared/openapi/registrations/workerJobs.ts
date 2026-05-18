import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage } from '../schemas/common';

const PublicJobItemSchema = registry.register(
  'PublicJobItem',
  z.object({
    id: z.string().uuid().openapi({ example: '6f7c1d4a-9b2e-4c8a-9d5e-1f3b8a2c7e91' }),
    title: z.string().openapi({ example: 'CASO 766-1' }),
    country: z.string().openapi({ example: 'AR' }),
    state: z.string().nullable().openapi({ example: 'Buenos Aires' }),
    city: z.string().nullable().openapi({ example: 'Palermo' }),
    pathology: z.string().nullable().openapi({ example: 'TEA' }),
    worker_sex: z.string().nullable().openapi({ example: 'FEMALE' }),
    worker_type: z.string().nullable().openapi({ example: 'AT' }),
    status: z.string().openapi({ example: 'SEARCHING' }),
  }).openapi({ description: 'Item de vaga pública para o worker.' }),
);

registry.registerPath({
  method: 'get',
  path: '/api/jobs',
  tags: ['Worker · Jobs'],
  summary: 'Lista vagas disponíveis para o worker',
  description:
    'Retorna vagas ativas filtradas por país, estado, cidade, patologia e perfil do worker. ' +
    'Público — não requer autenticação. Cache público de 5 minutos.',
  security: [],
  request: {
    query: z.object({
      country: z.string().optional().openapi({ description: 'Código ISO país (2 letras, default AR).', example: 'AR' }),
      state: z.string().optional().openapi({ description: 'Estado/província.', example: 'Buenos Aires' }),
      city: z.string().optional().openapi({ description: 'Cidade.', example: 'Palermo' }),
      pathology: z.string().optional().openapi({ description: 'Patologia do paciente.', example: 'TEA' }),
      worker_sex: z.enum(['FEMALE', 'MALE', 'BOTH']).optional().openapi({ description: 'Sexo do worker preferido.' }),
      worker_type: z.string().optional().openapi({ description: 'Tipo de worker.', example: 'AT' }),
      q: z.string().optional().openapi({ description: 'Busca textual livre.', example: 'cuidador' }),
    }),
  },
  responses: {
    200: {
      description: 'Lista de vagas disponíveis.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(PublicJobItemSchema),
          }),
        },
      },
    },
    400: { description: 'Query params inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/jobs/refresh',
  tags: ['Worker · Jobs'],
  summary: 'Força atualização das vagas do worker',
  description:
    'Dispara novo cálculo de matching para o worker autenticado e retorna vagas atualizadas. ' +
    'Requer Firebase token.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Vagas atualizadas.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
