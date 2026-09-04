/**
 * src/modules/identity/interfaces/routes/permissionPanelRoutes.ts
 *
 * A família `admin.permissions` — a API de LEITURA do painel de acessos (F3 do
 * plano, task 4.1 na parte de leitura). Seis rotas, TODAS `GET`, todas sob
 * `permission_management:read`.
 *
 * ⚠️ **NÃO existe rota de escrita aqui, e não é omissão:** escrita em `iam.*`
 * só pode sair das funções `SECURITY DEFINER` da mig 279 (lex C4) — a role do
 * app teve INSERT/UPDATE/DELETE REVOGADO nessas tabelas pela mig 269. Para o
 * compilador ajudar a manter isso, os repositórios entram por PORTAS ESTREITAS
 * (`PanelGroupReader`, `PanelFeatureReader`), que só declaram os métodos de
 * leitura: um `addMember` chamado por engano daqui não compila. É a F4 que
 * abre a escrita, com a bateria de abuso da 4.1b junto.
 *
 * ── Por que a família existe, antes do painel ────────────────────────────────
 * `GET /permissions/catalog` é quem DECLARA `permission_management:read`.
 * Nenhuma rota do sistema declarava essa célula (medido: `git grep
 * permission_management` achava só a `:write`, em `adminUsersRoutes.ts:72`).
 * Com `PERMISSION_CATALOG_SYNC_ENABLED` ligado na `stage` pelo #245, o sync
 * conclui que a célula sumiu do código e a DESCONTINUA;
 * `iam.effective_permissions` filtra `deprecated_at IS NULL`; e
 * `iam.query_audit` (mig 280:143) passa a levantar **42501 para todo mundo,
 * inclusive o Acesso Master**. Declarada, o próximo boot faz
 * `deprecated_at = NULL` e loga `'revived'`.
 *
 * ── O que estas rotas expõem de dado pessoal ─────────────────────────────────
 * Duas delas tocam dado de PESSOA, e nas duas o recorte vem do veredito do lex,
 * não da minha conveniência:
 *   · membros do grupo — e-mail, papel e status de STAFF. É o mesmo dado que
 *     `GET /api/admin/users` serve sob `user_management:read`, e aqui ele sai
 *     por uma célula DIFERENTE — não por um subconjunto.
 *
 *     ⚠️ Eu tinha escrito aqui "o portão é mais estreito, nunca mais largo", e
 *     era FALSO: as duas células são independentes, e o próprio e2e é o
 *     contraexemplo (a gestora do teste tem só `permission_management:read` e
 *     lê e-mail de staff). O gate `revisao-pr` pegou. O comportamento está
 *     dentro da spec — a tela de grupo "mostra os membros", gated em
 *     `permission_management` — mas quem tem essa célula e NÃO tem
 *     `user_management:read` ganha uma segunda porta para o mesmo dado. Isso é
 *     desenho, não descuido; a frase é que não podia mentir sobre ele.
 *   · a trilha — `iam.query_audit` devolve identificador e metadado, NUNCA
 *     conteúdo (spec "Vista de auditoria"), e o `resourceId` já vem como
 *     `'<oculto>'` quando o auditor não tem escopo no país da linha (mig 283).
 *     A linha continua aparecendo de propósito: esconder a linha inteira
 *     tornaria o acesso cross-país invisível para quem existe para detectá-lo.
 * O gate da trilha **não está aqui**: está na função `iam.query_audit`, que
 * exige a célula do ator no GUC e registra o próprio ato de auditar (lex C7). A
 * célula na rota é a segunda tranca, não a única.
 *
 * ⚠️ O `requireStaff` fica ALÉM da célula, como nas outras famílias: enquanto
 * `admin.permissions` não estiver em `PERMISSION_ENFORCED_ROUTES` (F13), o
 * guard de papel é a ÚNICA proteção viva destas rotas. Tirar agora seria abri-las.
 */

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { COUNTRY_CODES } from '@shared/domain/countryCodes';
import {
  ENLITE_TENANT_ID,
  type CountryFeature,
  type GroupMemberView,
  type ListPermissionCatalogUseCase,
  type PermissionGroupDetail,
  type QueryPermissionAuditUseCase,
} from '@modules/identity/permissions';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';

export const ADMIN_PERMISSIONS_FAMILY = 'admin.permissions';

/**
 * Porta ESTREITA do repositório de grupos: só leitura. Ver o aviso do
 * cabeçalho — a estreiteza é o que faz o compilador recusar escrita daqui.
 */
export interface PanelGroupReader {
  list(tenantId: string, options?: { includeArchived?: boolean }): Promise<PermissionGroupDetail[]>;
  findById(tenantId: string, groupId: string): Promise<PermissionGroupDetail | null>;
  listMembers(tenantId: string, groupId: string): Promise<GroupMemberView[]>;
}

/** Idem para disponibilidade por país. */
export interface PanelFeatureReader {
  list(): Promise<CountryFeature[]>;
}

export interface PermissionPanelDeps {
  catalog: ListPermissionCatalogUseCase;
  groups: PanelGroupReader;
  features: PanelFeatureReader;
  audit: QueryPermissionAuditUseCase;
  auth: AuthMiddleware;
  permissions: PermissionMiddleware;
  tenantId?: string;
}

// ── Zod na borda (task 4.1) ──────────────────────────────────────────────────

/**
 * `'true'`/`'false'` explícitos, e nada mais. Query string não tem booleano: o
 * atalho comum (`!!req.query.x`) faz `?includeArchived=false` ligar o filtro,
 * que é o oposto do que quem escreveu a URL pediu.
 */
const CatalogQuery = z
  .object({ includeDeprecated: z.enum(['true', 'false']).optional() })
  .transform((q) => q.includeDeprecated === 'true');

const GroupsQuery = z
  .object({ includeArchived: z.enum(['true', 'false']).optional() })
  .transform((q) => q.includeArchived === 'true');

/** Id malformado é 400, não 500: sem isto o `uuid` inválido explode no cast do Postgres. */
const GroupParams = z.object({ id: z.string().uuid() });

const FeaturesQuery = z.object({ country: z.enum(COUNTRY_CODES).optional() });

/**
 * ⚠️ O `limit` é validado AQUI e clampado DE NOVO no use case (1..1000), e a
 * redundância é de propósito: o use case é a fronteira que vale mesmo se algum
 * chamador futuro pular a rota. Aqui o papel do zod é recusar `limit=abc` com
 * 400 em vez de deixar virar `NaN` silencioso.
 *
 * `.strict()`: `userId` NÃO é campo desta query — e uma chave desconhecida
 * agora é 400, não descartada em silêncio. Decisão fail-closed contra
 * deploy-skew: uma aba com bundle ANTIGO que ainda manda `?userId=X` (de antes
 * do uid sair da query string, C6) receberia hoje a trilha de TODO MUNDO sob o
 * cabeçalho "trilha de X" — silencioso, sem 400, sem log. `.strict()` recusa
 * a request em vez de servir dado errado.
 */
const AuditQuery = z
  .object({
    resource: z.string().min(1).max(64).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

// `userId` saiu da query string em `GET /permission-audit` (parecer jurídico,
// condição C6 — uid de funcionário não pode cair no log de request do Cloud
// Run). O filtro por pessoa sobrevive só aqui, em `POST .../query`, no corpo —
// por isso é a MESMA forma da `AuditQuery` mais este único campo, não uma
// cópia (a duplicação já causou os dois se desalinharem uma vez).
const AuditBody = AuditQuery.extend({
  userId: z.string().min(1).max(128).optional(),
});

// ── Casca comum ──────────────────────────────────────────────────────────────

/**
 * Não há `asyncHandler` na casa, e rejeição de handler `async` NÃO chega ao
 * error handler do Express 4 — vira `unhandledRejection` e a request pendura
 * até o timeout do cliente. Este wrapper é o que fecha isso, uma vez, em vez de
 * seis `try` copiados.
 */
function responder<T>(res: Response, rotulo: string, trabalho: () => Promise<T | null>): void {
  void trabalho()
    .then((corpo) => {
      // `null` é "não achei" — e inclui o grupo de OUTRO TENANT, que a porta
      // devolve como `null` de propósito: 404 indistinguível de inexistente,
      // senão o 403 confirmaria que o id existe em algum lugar (spec).
      if (corpo === null) {
        res.status(404).json({ success: false, error: 'Not found' });
        return;
      }
      res.json(corpo);
    })
    .catch((err: unknown) => {
      logger.error({ err, rotulo }, '[perm] falha na API de leitura do painel');
      res.status(500).json({ success: false, error: `Failed to read ${rotulo}` });
    });
}

export function createPermissionPanelRoutes(deps: PermissionPanelDeps): Router {
  const router = Router();
  const perm = deps.permissions.family(ADMIN_PERMISSIONS_FAMILY);
  const tenantId = deps.tenantId ?? ENLITE_TENANT_ID;

  /** Os dois guards de toda rota desta família, na ordem: papel → célula. */
  const portao: RequestHandler[] = [
    deps.auth.requireStaff(),
    perm.require('permission_management', 'read'),
  ];

  router.get('/permissions/catalog', ...portao, (req, res) => {
    const query = CatalogQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query parameters' });
      return;
    }

    responder(res, 'permission catalog', async () => ({
      categories: await deps.catalog.execute({ includeDeprecated: query.data }),
    }));
  });

  router.get('/permission-groups', ...portao, (req, res) => {
    const query = GroupsQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query parameters' });
      return;
    }

    responder(res, 'permission groups', async () => ({
      groups: await deps.groups.list(tenantId, { includeArchived: query.data }),
    }));
  });

  // ⚠️ ANTES de `/:id` — não porque `/:id` engoliria (é um segmento só), mas
  // porque a ordem estática→dinâmica é a convenção da casa e a próxima rota
  // acrescentada aqui pode não ter essa sorte.
  router.get('/permission-groups/:id/members', ...portao, (req, res) => {
    const params = GroupParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }

    responder(res, 'group members', async () => {
      // O grupo é conferido ANTES dos membros: sem isto, id de OUTRO tenant
      // devolveria `{members: []}` com 200 — indistinguível de "grupo vazio" e,
      // pior, confirmando que o id existe.
      const grupo = await deps.groups.findById(tenantId, params.data.id);
      if (!grupo) return null;
      return { members: await deps.groups.listMembers(tenantId, params.data.id) };
    });
  });

  router.get('/permission-groups/:id', ...portao, (req, res) => {
    const params = GroupParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }

    responder(res, 'permission group', () => deps.groups.findById(tenantId, params.data.id));
  });

  router.get('/country-features', ...portao, (req, res) => {
    const query = FeaturesQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query parameters' });
      return;
    }

    responder(res, 'country features', async () => {
      const todas = await deps.features.list();
      const pais = query.data.country;
      return { features: pais ? todas.filter((f) => f.country === pais) : todas };
    });
  });

  router.get('/permission-audit', ...portao, (req, res) => {
    const query = AuditQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query parameters' });
      return;
    }

    executarAuditoria(deps, res, query.data);
  });

  // POST, não GET: é a única forma de filtrar por `userId` sem o uid cair na
  // URL (parecer jurídico, C6). Continua exigindo `permission_management:read`
  // — mesma `portao` das rotas GET acima; é POST só na forma, leitura na regra.
  router.post('/permission-audit/query', ...portao, (req, res) => {
    const body = AuditBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid request body' });
      return;
    }

    executarAuditoria(deps, res, body.data);
  });

  return router;
}

/** Compartilhado pelo `GET` e pelo `POST .../query` — mesmo use case, mesma resposta. */
function executarAuditoria(
  deps: PermissionPanelDeps,
  res: Response,
  filtro: { userId?: string; resource?: string; since?: Date; until?: Date; limit?: number },
): void {
  responder(res, 'permission audit', async () => ({
    entries: await deps.audit.execute(filtro),
  }));
}
