/**
 * src/modules/identity/permissions/infrastructure/catalog/routeClass.ts
 *
 * Classe de rota declarada NA MONTAGEM (acesso-do-cliente F3, DF-14). Mesmo
 * mecanismo de `permissionMetadata.ts` (símbolo + `defineProperty` no handler,
 * lido por `scanExpressRouter`), sem mecanismo paralelo: a declaração e o
 * handler são o MESMO objeto, então não dá para ter uma sem o outro.
 *
 * Quatro valores: `staff` (marcada pelo próprio `requireStaff`), `public`,
 * `service` e `client-policy` (via `routeClass(...)` na rota). Rota sem marca
 * lê `null` — é o que o selo de boot e o teste de cobertura reprovam.
 *
 * A marca tem de ficar no handler que entra na pilha da rota: handler embrulhado
 * por outra função (ex. `rateLimit(...)`) perde a propriedade.
 */

import type { RequestHandler } from 'express';

export const ROUTE_CLASS_METADATA = Symbol.for('enlite.permissions.routeClass');

export const ROUTE_CLASSES = ['staff', 'public', 'service', 'client-policy'] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export type ClassedHandler = RequestHandler & { [ROUTE_CLASS_METADATA]?: RouteClass };

/** Carimba a classe no handler e devolve o MESMO handler (encadeável). */
export function markRouteClass<T extends RequestHandler>(handler: T, routeClass: RouteClass): T {
  Object.defineProperty(handler, ROUTE_CLASS_METADATA, {
    value: routeClass,
    enumerable: false,
    configurable: true,
  });
  return handler;
}

/** Classe declarada por este handler, se houver. */
export function readRouteClass(handler: unknown): RouteClass | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as ClassedHandler)[ROUTE_CLASS_METADATA];
}

/**
 * Handler que só carrega a marca: `router.get(p, routeClass('public'), h)`.
 * Não decide nada — o portão da rota continua sendo o guard que a acompanha.
 */
export function routeClass(cls: Exclude<RouteClass, 'staff'>): RequestHandler {
  const passthrough: RequestHandler = (_req, _res, next) => next();
  return markRouteClass(passthrough, cls);
}
