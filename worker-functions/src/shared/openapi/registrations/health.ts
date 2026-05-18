import { registry, z } from '../registry';

const HealthSchema = registry.register(
  'HealthStatus',
  z
    .object({
      status: z.literal('healthy').openapi({ example: 'healthy' }),
      timestamp: z.string().datetime().openapi({
        description: 'Momento da checagem em ISO 8601 UTC.',
        example: '2026-05-18T14:32:11.345Z',
      }),
    })
    .openapi({ description: 'Probe de liveness simples — sempre retorna 200 quando o processo está vivo.' }),
);

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Health · Status'],
  summary: 'Liveness probe',
  description:
    'Endpoint de saúde usado por Cloud Run e orquestradores. Não verifica DB ' +
    'nem dependências externas — apenas confirma que o processo Node está vivo ' +
    'e respondendo. Não exige autenticação.',
  responses: {
    200: {
      description: 'Processo vivo.',
      content: { 'application/json': { schema: HealthSchema } },
    },
  },
});
