/**
 * src/modules/identity/interfaces/middleware/denyUndeclaredRoutes.ts
 *
 * Deny-by-default de ROTA (task 3.4, spec permission-enforcement): rota do
 * domínio administrativo que não declara célula não passa. Sem isto, o modelo
 * teria um buraco silencioso — bastaria alguém montar `/api/admin/algo` sem
 * `requirePermission` para a rota ficar aberta a qualquer staff, e nada
 * acusaria.
 *
 * O Express não diz, antes do despacho, QUAL rota vai atender a request. Por
 * isso o guard consulta um ÍNDICE construído no boot a partir da varredura real
 * do router (`scanExpressRouter` + `buildRouteIndex`) — a mesma varredura que
 * alimenta o catálogo. Uma fonte só: não existe rota que o catálogo enxergue e
 * o guard não, nem o contrário.
 *
 * TRÊS listas, com propósitos diferentes (e é a diferença que importa):
 *   · ISENTAS (`EXEMPT_ROUTES`) — decisão de PRODUTO, permanente: não são
 *     decisão de staff (bootstrap do 1º admin, perfil próprio, telemetria de
 *     login). D116.
 *   · PENDENTES (`PENDING_DECLARATIONS`) — dívida TEMPORÁRIA do rollout: rotas
 *     que ainda não foram declaradas porque a família delas não chegou na task
 *     3.5. A lista só encolhe; o teste falha se alguém acrescentar linha nova.
 *   · o resto — rota nova sem declaração: 403 em runtime e teste vermelho.
 *
 * Gated por `PERMISSION_ENGINE_ENABLED`: com a flag off o guard não opina
 * (ambiente neutro até a virada, grupo 5).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { isEnvFlagOn } from '@shared/utils/envFlag';
import { buildRouteIndex, type RouteIndex, type ScannedRoute } from '@modules/identity/permissions';
import { EXEMPT_ROUTES, PENDING_DECLARATIONS, routeKey } from './undeclaredRouteLists';
import { pathOf } from './PermissionMiddleware';

/** Domínio governado por célula de staff (design 1b). */
export const GOVERNED_PREFIXES = ['/api/admin/', '/analytics/'] as const;

/**
 * Rotas de STAFF que o prefixo não alcança — governadas por NOME (19/08/2026).
 *
 * Achado medindo a 3ª família: `workerEncuadreRoutes` serve 10 rotas
 * `requireStaff` sob `/api/workers/` e `/api/cases/`, incluindo escrita de funil
 * (`PUT /api/workers/:id/status`). Fora do prefixo elas eram `not_governed`:
 * invisíveis ao deny-by-default, ao `PENDING_DECLARATIONS` e ao oráculo de
 * rotas. Depois da virada, um grupo com só `worker:read` seguiria movendo o
 * funil — e nada avisaria.
 *
 * **Por que por NOME e não ampliando o prefixo** (decisão do Gabriel, 19/08):
 * `/api/workers/` abriga ~21 rotas do PRESTADOR e públicas (`/workers/me/*`,
 * `/workers/init`, `/workers/lookup`). Ampliar o prefixo puxaria todas para
 * dentro da rede de deny-by-default, cada uma precisando de uma entrada em
 * `EXEMPT_ROUTES` — e uma esquecida = app do candidato em 403 no dia da virada.
 * É a mesma classe de risco que obrigou o desvio de não-staff no motor (D119.1a).
 * A lista nomeada custa uma linha por rota e não toca em nada do prestador.
 *
 * ⚠️ O preço desta lista é ser MANUAL: rota de staff nova criada fora do
 * prefixo continua nascendo sem rede. Por isso ela é curta, fechada e citada no
 * handoff — não é substituto de prefixo, é o recorte de uma exceção conhecida.
 */
export const GOVERNED_ROUTES: ReadonlySet<string> = new Set([
  // workerEncuadreRoutes.ts — funil/encuadre do prestador, tudo `requireStaff`
  'GET /api/workers/status-dashboard',
  'GET /api/workers/by-status/:status',
  'PUT /api/workers/:id/status',
  'PUT /api/workers/:id/occupation',
  'GET /api/workers/docs-expiring',
  'PUT /api/workers/:id/doc-expiry',
  'GET /api/workers/:id/encuadres',
  'GET /api/workers/:id/cases',
  'GET /api/cases/:caseNumber/encuadres',
  'GET /api/cases/:caseNumber/workers',
  // `GET /v1/me/authz` SAIU daqui em 28/08/2026: ela agora se declara isenta NA
  // MONTAGEM (`exemptHandler`, ver `isGovernedRoute`), e é a marca que a põe no
  // perímetro — não uma linha aqui e outra em `EXEMPT_ROUTES`. As 10 acima
  // ficam como REDE: todas declaram célula hoje (task 3.5), mas se alguém tirar
  // o `perm.require` de uma delas a lista ainda a mantém governada — e
  // `undeclared`. Montagem é a fonte; a lista é o cinto para a regressão.
]);

/**
 * ⚠️ Comparação em MINÚSCULAS porque o Express roda com `case sensitive routing`
 * DESLIGADO (o default): `/API/ADMIN/foo` é despachado para o mesmo handler que
 * `/api/admin/foo`. Comparar com `startsWith` sensível a caixa deixava a rede de
 * deny-by-default com um furo de uma linha — bastava a caixa diferente para a
 * rota virar `not_governed` e passar. Achado em revisão, provado com repro.
 */
export function isGovernedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return GOVERNED_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix));
}

/**
 * Governança de uma rota IDENTIFICADA (tem método e PADRÃO de caminho): a
 * MARCA da montagem, o prefixo, ou a lista nomeada. É aqui que a decisão real
 * acontece — o `isGovernedPath` acima só vê o caminho concreto da request e
 * não sabe a qual padrão ele pertence.
 *
 * **Marca primeiro (28/08/2026, achado #9 da 002):** rota cujo handler declara
 * célula (`perm.require`) ou isenção (`perm.exempt`) está no perímetro por
 * definição — a declaração É a intenção, e ela fica onde a rota é montada, não
 * numa lista que alguém precisa lembrar de editar. Foi assim que
 * `GET /v1/me/authz` nasceu `not_governed`: fora do prefixo, sem linha. Rota do
 * prestador NÃO é alcançada por isto — ela não carrega marca nenhuma — e o
 * desvio de não-staff do motor (D119) segue valendo.
 */
export function isGovernedRoute(route: ScannedRoute): boolean {
  return (
    route.cell !== undefined ||
    route.exempt !== undefined ||
    isGovernedPath(route.path) ||
    GOVERNED_ROUTES.has(routeKey(route.method, route.path))
  );
}

export type RouteStatus = 'declared' | 'exempt' | 'pending' | 'undeclared' | 'not_governed' | 'unknown';

export interface RouteListOverrides {
  exempt?: ReadonlySet<string>;
  pending?: ReadonlySet<string>;
}

/**
 * Índice publicado pelo boot. Nasce vazio de propósito: até as tarefas de boot
 * rodarem o guard responde `unknown` e deixa passar — negar nesse intervalo
 * derrubaria o painel por uma corrida de inicialização, e a flag do engine
 * ainda gateia tudo.
 */
export class UndeclaredRouteRegistry {
  private index: RouteIndex | null = null;
  private readonly exempt: ReadonlySet<string>;
  private readonly pending: ReadonlySet<string>;

  /**
   * As listas são injetáveis só para teste. Em produção valem as do arquivo —
   * passar outra coisa no boot seria mover a dívida de rollout para fora da
   * revisão de código, que é justamente o que a lista existe para impedir.
   */
  constructor(overrides: RouteListOverrides = {}) {
    this.exempt = overrides.exempt ?? EXEMPT_ROUTES;
    this.pending = overrides.pending ?? PENDING_DECLARATIONS;
  }

  publish(routes: ScannedRoute[]): void {
    this.index = buildRouteIndex(routes);
  }

  /** Toda rota registrada (vazio antes do boot publicar). */
  all(): ScannedRoute[] {
    return this.index?.all() ?? [];
  }

  /**
   * A célula é DECLARADA por alguma rota? É o que separa "o novo modelo governa
   * isto" de "isto é chamada legada, que segue como sempre foi" — o
   * `GroupPermissionEngine` usa para não decidir sobre células que nenhuma rota
   * declarou (e que, por não estarem no catálogo, grupo nenhum poderia conceder).
   * Antes do boot publicar responde `false` para tudo: nada é governado.
   */
  declaresCell(resource: string, action: string): boolean {
    return this.all().some(
      (route) => route.cell?.resource === resource && route.cell?.action === action,
    );
  }

  /** Rotas governadas sem declaração e fora das duas listas — a dívida NOVA. */
  unexpectedlyUndeclared(): ScannedRoute[] {
    return this.all().filter((route) => this.statusOfRoute(route) === 'undeclared');
  }

  /** Status de uma rota JÁ identificada — sem passar pelo casamento de caminho. */
  statusOfRoute(route: ScannedRoute): RouteStatus {
    // A marca da montagem responde antes de qualquer lista: célula → declarada,
    // isenção → isenta. Só o que não está marcado passa pelo prefixo/listas.
    if (route.cell) return 'declared';
    if (route.exempt) return 'exempt';
    if (!isGovernedRoute(route)) return 'not_governed';
    const key = routeKey(route.method, route.path);
    if (this.exempt.has(key)) return 'exempt';
    if (this.pending.has(key)) return 'pending';
    return 'undeclared';
  }

  /**
   * Status a partir do que a REQUEST traz: método + caminho concreto
   * (`/api/workers/abc-123/status`), não o padrão.
   *
   * ⚠️ A ordem mudou em 19/08 e o motivo é a lista nomeada: `isGovernedPath`
   * não pode mais ser o primeiro corte, porque ele vê `/api/workers/abc-123/status`
   * e não tem como saber que aquilo é `PUT /api/workers/:id/status`. Quem sabe é
   * o índice. Então: resolve primeiro, decide depois — e o prefixo só responde
   * no caminho em que o índice não resolveu (antes do boot publicar, ou rota que
   * não existe), onde a resposta continua sendo exatamente a de antes.
   */
  statusOf(method: string, path: string): RouteStatus {
    const route = this.index?.find(method, path);
    if (route) return this.statusOfRoute(route);
    return isGovernedPath(path) ? 'unknown' : 'not_governed';
  }
}

export interface DenyUndeclaredOptions {
  env?: NodeJS.ProcessEnv;
}

export function denyUndeclaredRoutes(
  registry: UndeclaredRouteRegistry,
  options: DenyUndeclaredOptions = {},
): RequestHandler {
  const env = options.env ?? process.env;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isEnvFlagOn('PERMISSION_ENGINE_ENABLED', env)) return next();
    if (registry.statusOf(req.method, req.path) !== 'undeclared') return next();

    logger.error(
      { method: req.method, path: pathOf(req) },
      '[perm] rota administrativa sem permissão declarada — negada',
    );
    if (isEnvFlagOn('PERMISSION_REPORT_ONLY', env)) return next();
    res.status(403).json({
      success: false,
      error: 'Access denied',
      code: 'undeclared_route',
      reason: 'Esta rota não declara permissão. Fale com o time de engenharia.',
    });
  };
}
