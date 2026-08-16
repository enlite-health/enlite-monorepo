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
