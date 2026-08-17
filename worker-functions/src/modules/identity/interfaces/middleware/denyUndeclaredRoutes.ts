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

/** Domínio governado por célula de staff (design 1b). */
export const GOVERNED_PREFIXES = ['/api/admin/', '/analytics/'] as const;

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

export function isGovernedRoute(route: ScannedRoute): boolean {
  return isGovernedPath(route.path);
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
    if (!isGovernedRoute(route)) return 'not_governed';
    if (route.cell) return 'declared';
    const key = routeKey(route.method, route.path);
    if (this.exempt.has(key)) return 'exempt';
    if (this.pending.has(key)) return 'pending';
    return 'undeclared';
  }

  statusOf(method: string, path: string): RouteStatus {
    if (!isGovernedPath(path)) return 'not_governed';
    if (!this.index) return 'unknown';
    const route = this.index.find(method, path);
    return route ? this.statusOfRoute(route) : 'unknown';
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
      { method: req.method, path: req.originalUrl.split('?')[0] },
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
