/**
 * src/shared/openapi/registrations/permissionsPanel.ts
 *
 * A API de leitura do painel de acessos (F3). Sete rotas, e o contraste entre
 * as duas primeiras é o que documenta o desenho:
 *
 *  · `GET /v1/me/authz` — *self*. Qualquer staff autenticado lê o PRÓPRIO
 *    contrato; não pede célula, e não aceita `uid` de ninguém (o principal é a
 *    única fonte do sujeito). Contrato versionado — `/v1`, não `/api/admin`.
 *  · `GET /api/admin/permissions/catalog` — decisão de staff. Pede
 *    `permission_management:read`, e é esta declaração que mantém a célula
 *    viva no catálogo derivado do código.
 */

/**
 * ⚠️ COBERTURA — justificativa técnica escrita, que o critério 3 do
 * `revisao-pr` exige (M3 do gate).
 *
 * Este arquivo fica em 0% de statements no `npm test -- --coverage`, e os
 * **38 de 38** vizinhos de `registrations/` também — medido. Não é dívida
 * nova nem descuido: o módulo é declaração pura (`registry.registerPath`),
 * executado por import de efeito colateral no `registrations/index.ts`, e a
 * camada que o exercita é OUTRA — `tests/playwright/swagger-coverage.spec.ts`,
 * que FALHA se uma rota Express não tiver registro.
 *
 * Por isso ele NÃO entra no `coverageThreshold`: pôr um piso de 100% aqui
 * reprovaria o CI por um número que a suíte unit não tem como produzir, e gate
 * que reprova o certo se aprende a ignorar (D172). A rede real destas 7 rotas é
 * o swagger-coverage; se ele parar de rodar, é ELE que precisa voltar — não um
 * teste inventado para colorir esta linha.
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';
import { COUNTRY_CODES as COUNTRY_CODES_DOC } from '@shared/domain/countryCodes';

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
      enforcement: z.enum(['on', 'off']).openapi({
        description:
          'Reflete `PERMISSION_ENGINE_ENABLED` no ambiente (D268). `off` = `groups` vem do banco mas ' +
          'NENHUMA rota está de fato gateada — "sem grupo" ainda não significa "sem acesso".',
        example: 'off',
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

// ── Grupos, países e trilha ─────────────────────────────────────────────────

const PermissionGroupSchema = registry.register(
  'PermissionGroupDetail',
  z
    .object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      name: z.string().openapi({ example: 'Recrutamento AR' }),
      description: z.string().nullable(),
      isSystem: z.boolean().openapi({ description: 'Semeado pela mig 206 — não renomeia, não arquiva.' }),
      archivedAt: z.string().datetime().nullable(),
      createdBy: z.string().nullable(),
      createdAt: z.string().datetime(),
      cells: z.array(z.string()).openapi({ description: 'Chaves `recurso:ação` do grupo.', example: ['worker:read'] }),
      countries: z.array(z.string()).openapi({ example: ['AR'] }),
      memberCount: z.number().int().openapi({ description: 'Membros vivos — a tela avisa antes de arquivar.' }),
    })
    .openapi({ description: 'Grupo com os dois eixos resolvidos: células e países.' }),
);

const GroupMemberSchema = z
  .object({
    userId: z.string(),
    email: z.string().nullable(),
    role: z.string().nullable(),
    status: z.enum(['ACTIVE', 'PENDING_ONBOARDING', 'SUSPENDED', 'DEACTIVATED']).nullable(),
    assignedBy: z.string().nullable(),
    assignedAt: z.string().datetime(),
  })
  .openapi({ description: 'Membro do grupo. Dado de STAFF — o mesmo que `GET /api/admin/users` serve sob um portão mais largo.' });

const CountryFeatureSchema = z
  .object({
    country: z.string().openapi({ example: 'AR' }),
    featureKey: z.string().openapi({ example: 'screen:talentum' }),
    enabled: z.boolean(),
    config: z.unknown(),
    source: z.enum(['default', 'override']).openapi({ description: '`default` = manifest em código; `override` = painel.' }),
    reason: z.string().nullable(),
    updatedBy: z.string(),
    updatedAt: z.string().datetime(),
  })
  .openapi({ description: 'Disponibilidade de uma feature num país.' });

const AuditRowSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    resource: z.string(),
    action: z.string(),
    resourceId: z.string().nullable().openapi({
      description:
        '`<oculto>` quando o auditor não tem escopo no país da linha (mig 283). A LINHA aparece de ' +
        'propósito — esconder tornaria o acesso cross-país invisível para quem existe para detectá-lo.',
    }),
    decision: z.string().openapi({ example: 'DENY' }),
    createdAt: z.string().datetime(),
    country: z.string().nullable(),
  })
  .openapi({ description: 'Uma decisão da trilha. Identificador e metadado — nunca conteúdo de dado pessoal.' });

const painel = (path: string, summary: string, description: string, ok: z.ZodTypeAny, extras: Record<number, string> = {}) => {
  registry.registerPath({
    method: 'get',
    path,
    tags: ['Painel · Acessos'],
    summary,
    description,
    security: [{ firebaseAuth: [] }],
    responses: {
      200: { description: 'OK.', content: { 'application/json': { schema: ok } } },
      400: { description: 'Query ou id inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      403: { description: 'Sem `permission_management:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      ...Object.fromEntries(
        Object.entries(extras).map(([code, desc]) => [
          code,
          { description: desc, content: { 'application/json': { schema: ErrorResponseSchema } } },
        ]),
      ),
      500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });
};

painel(
  '/api/admin/permission-groups',
  'Lista os grupos de permissão do tenant',
  'Cada grupo já vem com os dois eixos resolvidos (células e países) e a contagem de membros vivos. ' +
    '`?includeArchived=true` traz os arquivados — arquivar não apaga.',
  z.object({ groups: z.array(PermissionGroupSchema) }),
);

painel(
  '/api/admin/permission-groups/{id}',
  'Detalhe de um grupo',
  'Grupo de OUTRO tenant devolve 404, indistinguível de inexistente: um 403 confirmaria que o id ' +
    'existe em algum lugar.',
  PermissionGroupSchema,
  { 404: 'Grupo inexistente neste tenant.' },
);

painel(
  '/api/admin/permission-groups/{id}/members',
  'Membros vivos de um grupo',
  'Dado de STAFF (e-mail, papel, status). O grupo é conferido ANTES: id de outro tenant devolve 404, ' +
    'nunca `{members: []}` com 200 — o 200 vazio confirmaria a existência do id.',
  z.object({ members: z.array(GroupMemberSchema) }),
  { 404: 'Grupo inexistente neste tenant.' },
);

painel(
  '/api/admin/country-features',
  'Disponibilidade de features por país',
  'A matriz país × feature: padrão do manifest e overrides do painel. `?country=AR` filtra; país fora ' +
    'do catálogo é 400, não lista vazia.',
  z.object({ features: z.array(CountryFeatureSchema) }),
);

painel(
  '/api/admin/permission-audit',
  'Trilha de decisões de permissão',
  'O gate real NÃO está na rota: está em `iam.query_audit` (mig 279/280), que exige a célula do ator ' +
    'no GUC e registra o próprio ato de auditar (lex C7). A role do app não tem SELECT na tabela. ' +
    'Filtros: `resource`, `since`, `until`, `limit` (1..1000, default 200) — `userId` NÃO é filtro de ' +
    'query aqui (parecer jurídico, C6: uid não pode cair no log de request do Cloud Run); use ' +
    '`POST /api/admin/permission-audit/query` para filtrar por pessoa. ' +
    'A vista nunca expõe conteúdo de dado pessoal — só identificadores e metadados.',
  z.object({ entries: z.array(AuditRowSchema) }),
);

registry.registerPath({
  method: 'post',
  path: '/api/admin/permission-audit/query',
  tags: ['Painel · Acessos'],
  summary: 'Trilha de decisões de permissão, filtrada por pessoa',
  description:
    'Mesma leitura de `GET /api/admin/permission-audit` — só existe como POST porque `userId` é o ' +
    'único jeito de filtrar por pessoa sem o uid cair na URL (parecer jurídico, C6). Exige a MESMA ' +
    '`permission_management:read`; é POST na forma, leitura na regra. ' +
    '(M7) Chave extra no corpo é 400: `AuditBody`, na rota, herda `.strict()` de `AuditQuery` — ' +
    'fail-closed contra deploy-skew (C6), a mesma razão que motivou o `.strict()` original.',
  security: [{ firebaseAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z
            .object({
              userId: z.string().max(128).optional(),
              resource: z.string().max(64).optional(),
              since: z.string().datetime().optional(),
              until: z.string().datetime().optional(),
              limit: z.number().int().min(1).max(1000).optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: { description: 'OK.', content: { 'application/json': { schema: z.object({ entries: z.array(AuditRowSchema) }) } } },
    400: { description: 'Corpo inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem `permission_management:read`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ── ESCRITA (F4) ─────────────────────────────────────────────────────────────
//
// ⚠️ O portão destas rotas NÃO é o `perm.require` do Express: cada escrita desce
// para uma função `SECURITY DEFINER` da mig 279, onde `iam._require_manager()`
// exige `permission_management:write` vigente do ator, dentro da transação. A
// role do app teve INSERT/UPDATE/DELETE revogado em `iam.*` pela mig 269.

const escrita = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  summary: string,
  description: string,
  body?: z.ZodTypeAny,
) => {
  registry.registerPath({
    method,
    path,
    tags: ['Painel · Acessos'],
    summary,
    description,
    security: [{ firebaseAuth: [] }],
    ...(body ? { request: { body: { content: { 'application/json': { schema: body } } } } } : {}),
    responses: {
      200: { description: 'OK.', content: { 'application/json': { schema: z.object({}).passthrough() } } },
      400: { description: 'Payload, id ou país inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      403: { description: 'Sem `permission_management:write` — recusado PELO BANCO.', content: { 'application/json': { schema: ErrorResponseSchema } } },
      404: { description: 'Grupo inexistente ou de outro tenant (indistinguíveis).', content: { 'application/json': { schema: ErrorResponseSchema } } },
      409: { description: 'Nome repetido, grupo de sistema, ou anti-lockout (`last_manager`).', content: { 'application/json': { schema: ErrorResponseSchema } } },
      500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });
};

escrita('post', '/api/admin/permission-groups', 'Cria um grupo de permissão',
  'O criador fica registrado em `created_by`.',
  z.object({ name: z.string().max(255), description: z.string().max(2000).nullable().optional() }));

escrita('patch', '/api/admin/permission-groups/{id}', 'Renomeia ou redescreve um grupo',
  'Patch vazio é 400: "salvei nada" e "salvei" têm de ser respostas diferentes. Grupo de sistema não é renomeável (409).',
  z.object({ name: z.string().max(255).optional(), description: z.string().max(2000).nullable().optional() }));

escrita('delete', '/api/admin/permission-groups/{id}', 'Arquiva um grupo',
  'ARQUIVA, não apaga: a trilha do grupo tem de sobreviver ao grupo. Recusado com 409 `last_manager` se deixasse zero gestores.');

escrita('put', '/api/admin/permission-groups/{id}/permissions', 'Substitui o conjunto de células do grupo',
  'PUT, não PATCH: o conjunto vai inteiro e o diff vira trilha. Um PATCH incremental esconderia a REMOÇÃO de célula dentro de um "adicionei X". Lista vazia é operação legítima — o anti-lockout do banco é quem recusa se isso deixar zero gestores.',
  z.object({ cellKeys: z.array(z.string()).max(500), reason: z.string().max(500).nullable().optional() }));

escrita('post', '/api/admin/permission-groups/{id}/countries', 'Concede um país ao grupo',
  'Motivo OBRIGATÓRIO — é o que a trilha guarda.',
  z.object({ country: z.enum(COUNTRY_CODES_DOC), reason: z.string().max(500) }));

escrita('delete', '/api/admin/permission-groups/{id}/countries/{country}', 'Revoga um país do grupo',
  'REVOGA sem apagar: concessão e revogação ficam as duas na trilha.');

escrita('post', '/api/admin/permission-groups/{id}/members', 'Adiciona membro ao grupo',
  'O vínculo guarda quem concedeu.',
  z.object({ userId: z.string().max(128) }));

escrita('delete', '/api/admin/permission-groups/{id}/members', 'Remove membro do grupo',
  'Marca `removed_at`, não apaga. Recusado com 409 `last_manager` se fosse o último gestor — inclusive quando a pessoa remove a si mesma. ' +
    'No Acesso Master, recusado com 409 `fixed_account` se for uma das 5 contas fixas (B-1, mig 451). ' +
    '`userId` vai no CORPO, não no path — uid de funcionário não pode cair no log de request do Cloud Run (parecer jurídico, C6).',
  z.object({ userId: z.string().max(128) }));

escrita('put', '/api/admin/country-features/{country}/{featureKey}', 'Liga/desliga uma feature num país',
  'Override do painel sobre o padrão do manifest. Motivo obrigatório; a mudança anterior vai para `country_feature_changes`.',
  z.object({ enabled: z.boolean(), config: z.unknown().optional(), reason: z.string().max(500) }));
