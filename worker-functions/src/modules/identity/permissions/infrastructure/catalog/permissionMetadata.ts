/**
 * src/modules/identity/permissions/infrastructure/catalog/permissionMetadata.ts
 *
 * O elo entre "a rota declara o que exige" e "o catálogo existe no banco"
 * (design 1b): o middleware de permissão (grupo 3) CARIMBA a célula no próprio
 * handler; o scanner (`scanExpressRouter`) lê o carimbo percorrendo o router.
 *
 * Por que carimbar a função em vez de manter uma lista: lista à mão sai de
 * sincronia no dia em que alguém remove a rota e esquece a linha — e o catálogo
 * passa a oferecer, na tela de grupo, uma permissão que não governa mais nada.
 * Carimbando, a declaração e o enforcement são o MESMO objeto: não dá para ter
 * um sem o outro. Modelo: `createPermission` do Backstage e o
 * `DiscoveryService` do NestJS.
 *
 * Símbolo (não string) para não colidir com propriedades do Express nem
 * aparecer em enumeração de chaves.
 */

import type { RequestHandler } from 'express';

export const PERMISSION_METADATA = Symbol.for('enlite.permissions.cell');

export interface PermissionMetadata {
  resource: string;
  action: string;
  description?: string | null;
}

/** Handler com a célula declarada — o que o scanner procura. */
export type DeclaredHandler = RequestHandler & { [PERMISSION_METADATA]?: PermissionMetadata };

/** Carimba a célula no handler e devolve o MESMO handler (encadeável). */
export function markPermissionHandler<T extends RequestHandler>(handler: T, cell: PermissionMetadata): T {
  Object.defineProperty(handler, PERMISSION_METADATA, {
    value: cell,
    enumerable: false,
    configurable: true,
  });
  return handler;
}

/** Célula declarada por este handler, se houver. */
export function readPermissionMetadata(handler: unknown): PermissionMetadata | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as DeclaredHandler)[PERMISSION_METADATA];
}

/**
 * Isenção declarada NA MONTAGEM (28/08/2026, achado #9 da 002).
 *
 * Uma rota de staff isenta de célula (`self`, D116) era invisível ao perímetro
 * quando morava fora dos prefixos: precisava de uma linha em `GOVERNED_ROUTES`
 * E outra em `EXEMPT_ROUTES` — duas listas à mão para dizer "esta rota existe e
 * é isenta". Foi assim que `GET /v1/me/authz` nasceu `not_governed`. Carimbar a
 * isenção no handler faz a MONTAGEM ser a fonte, como já é para a célula: a
 * rota entra no inventário porque está marcada, não porque alguém lembrou.
 */
export const EXEMPT_METADATA = Symbol.for('enlite.permissions.exempt');

export interface ExemptMetadata {
  /** Por que esta rota não exige célula — texto revisável, vai ao inventário. */
  reason: string;
}

export type ExemptHandler = RequestHandler & { [EXEMPT_METADATA]?: ExemptMetadata };

/** Carimba a isenção no handler e devolve o MESMO handler. */
export function markExemptHandler<T extends RequestHandler>(handler: T, exempt: ExemptMetadata): T {
  Object.defineProperty(handler, EXEMPT_METADATA, {
    value: exempt,
    enumerable: false,
    configurable: true,
  });
  return handler;
}

/** Isenção declarada por este handler, se houver. */
export function readExemptMetadata(handler: unknown): ExemptMetadata | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as ExemptHandler)[EXEMPT_METADATA];
}

/**
 * Handler que só existe para carregar a marca: `router.get(p, guard, exemptHandler('self'), h)`.
 * Não decide nada — o portão da rota continua sendo o guard que a acompanha.
 */
export function exemptHandler(reason: string): RequestHandler {
  const passthrough: RequestHandler = (_req, _res, next) => next();
  return markExemptHandler(passthrough, { reason });
}
