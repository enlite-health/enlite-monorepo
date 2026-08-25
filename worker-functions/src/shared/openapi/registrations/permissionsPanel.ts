/**
 * src/shared/openapi/registrations/permissionsPanel.ts
 *
 * A API de leitura do painel de acessos (F3). Duas rotas com naturezas
 * OPOSTAS, e o contraste é o que documenta o desenho:
 *
 *  · `GET /v1/me/authz` — *self*. Qualquer staff autenticado lê o PRÓPRIO
 *    contrato; não pede célula, e não aceita `uid` de ninguém (o principal é a
 *    única fonte do sujeito). Contrato versionado — `/v1`, não `/api/admin`.
 *  · `GET /api/admin/permissions/catalog` — decisão de staff. Pede
 *    `permission_management:read`, e é esta declaração que mantém a célula
 *    viva no catálogo derivado do código.
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

const PermissionCellSchema = z
  .object({
    resource: z.string().openapi({ example: 'worker_pii' }),
    action: z.string().openapi({ example: 'read' }),
    category: z.string().openapi({ example: 'Prestadores' }),
    description: z.string().nullable().optional().openapi({
      description: 'A definição escrita da célula (o que ela libera), preenchida em UM lugar.',
    }),
    ownerService: z.string().openapi({ example: 'worker-functions' }),
    deprecatedAt: z.string().datetime().nullable().optional().openapi({
      description: 'Preenchido quando a célula sumiu do código — a linha nunca é apagada.',
    }),
  })
  .openapi({ description: 'Uma célula `recurso:ação` do catálogo.' });

const AuthzContractSchema = registry.register(
  'AuthzContract',
  z
    .object({
      uid: z.string(),
      tenantId: z.string(),
      status: z
        .enum(['ACTIVE', 'PENDING_ONBOARDING', 'SUSPENDED', 'DEACTIVATED'])
        .nullable()
        .openapi({ description: 'Status da conta. `null` = conta não encontrada no tenant.' }),
      permissions: z.array(z.string()).openapi({
        description: 'Chaves `recurso:ação` — a UNIÃO dos grupos vigentes.',
        example: ['worker:read', 'funnel:read'],
      }),
      countries: z.array(z.string()).openapi({ example: ['AR'] }),
      groups: z
        .array(z.object({ id: z.string(), name: z.string() }))
        .openapi({ description: 'Grupos vigentes. Vazio = tela de boas-vindas.' }),
      features: z.record(z.record(z.object({ enabled: z.boolean(), config: z.unknown() }))).openapi({
        description: 'país → featureKey → disponibilidade. `enabled:false` = a tela nem aparece.',
      }),
    })
    .openapi({
      description:
        'Contrato agregado do painel (design 11). Uma resposta só: três endpoints separados dariam ' +
        'três estados de carregamento e a chance de renderizar com meia verdade.',
    }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/me/authz',
  tags: ['Painel · Acessos'],
  summary: 'O que o staff autenticado pode, onde, e o que está disponível no país',
  description:
    'Contrato agregado que o painel carrega uma vez no login e usa para decidir tudo. ' +
    'O sujeito é SEMPRE o principal autenticado — não existe forma de pedir o contrato de outra ' +
    'pessoa por esta rota. Não exige célula de propósito: gatear `self` trancaria fora justamente ' +
    'quem ainda não tem grupo, que é o público da tela de boas-vindas. ' +
    'Falha ao resolver responde 500, nunca contrato vazio: vazio é indistinguível de "sem grupo" ' +
    'na tela, e o painel mostraria boas-vindas a um admin por causa de uma oscilação do banco.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'O contrato do ator.', content: { 'application/json': { schema: AuthzContractSchema } } },
    401: { description: 'Não autenticado, ou principal sem uid (chave de API de serviço).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Autenticado, mas não é staff.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Falha ao resolver permissões.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/permissions/catalog',
  tags: ['Painel · Acessos'],
  summary: 'Catálogo de células agrupado por categoria (a matriz da tela de grupo)',
  description:
    'O catálogo é DERIVADO do código: cada rota declara a sua célula no próprio guard, e a ' +
    'varredura do boot sincroniza. Não carrega dado pessoal — expõe topologia, e por isso é ' +
    'gateado por `permission_management:read`.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      includeDeprecated: z.enum(['true', 'false']).optional().openapi({
        description:
          'Inclui células descontinuadas. Opt-in explícito: a tela de grupo NÃO pode oferecer ' +
          'célula morta para marcar — só a vista de auditoria, que mostra o que um grupo tinha numa data.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Catálogo por categoria.',
      content: {
        'application/json': {
          schema: z.object({
            categories: z.array(z.object({ category: z.string(), cells: z.array(PermissionCellSchema) })),
          }),
        },
      },
    },
    400: { description: 'Query inválida.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem `permission_management:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
