/**
 * src/modules/identity/permissions/infrastructure/catalog/scanExpressRouter.ts
 *
 * Varre o router do Express e devolve, para CADA rota registrada, o método, o
 * caminho e a célula declarada (se houver). É a fonte do catálogo derivado
 * (design 1b) e do teste "rota administrativa sem declaração falha o build"
 * (spec permission-enforcement) — as duas coisas leem a mesma varredura, então
 * não existe rota que apareça numa e não na outra.
 *
 * Anda no `_router.stack` do Express 4 recursivamente: cada camada é (a) uma
 * ROTA (`layer.route`), (b) um SUB-ROUTER montado (`layer.handle.stack`), ou (c)
 * um middleware solto (ignorado — não é endpoint).
 *
 * O caminho de um sub-router não é guardado como string pelo Express: ele vira a
 * `regexp` da camada. `mountPathOf` desfaz isso o suficiente para leitura humana
 * e para casar prefixo (`/api/admin`); é best-effort DE PROPÓSITO — a decisão de
 * segurança nunca depende dele (quem decide é a célula carimbada no handler).
 */

import type { Express, Router } from 'express';
import { readPermissionMetadata, type PermissionMetadata } from './permissionMetadata';

export interface ScannedRoute {
  /** Verbo em maiúsculas; `USE` para middleware montado como rota. */
  method: string;
  path: string;
  cell?: PermissionMetadata;
}

/** Camada interna do Express — tipada só no que esta varredura usa. */
interface ExpressLayer {
  name?: string;
  handle?: unknown;
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string | number }>;
  route?: {
    path?: string | string[];
    methods?: Record<string, boolean>;
    stack?: Array<{ handle?: unknown; method?: string }>;
  };
}

interface StackHolder {
  stack?: ExpressLayer[];
}

/**
 * Pilha de camadas da app/router. O Express 4 guarda em `_router` (criado
 * preguiçosamente na primeira rota); o 5 renomeou para `router`. Ler `router`
 * numa app do 4 LANÇA (getter de depreciação), por isso `_router` vem primeiro
 * e o acesso é protegido.
 */
function stackOf(target: unknown): ExpressLayer[] {
  const holder = target as { _router?: StackHolder; stack?: ExpressLayer[] };
  if (holder?._router?.stack) return holder._router.stack;
  if (Array.isArray(holder?.stack)) return holder.stack;
  try {
    const modern = (target as { router?: StackHolder }).router;
    return modern?.stack ?? [];
  } catch {
    return [];
  }
}

/**
 * Grupo de PARÂMETRO como o `path-to-regexp` do Express 4 emite:
 * `(?:\/([^/]+?))` — com a barra DENTRO do grupo e a classe sem escape. A
 * `\\?` cobre a variante escapada (`[^\/]`), que aparece em outras versões:
 * ancorar numa forma só faria `/vacancies/:id/candidates` virar um caminho com
 * regex no meio, e o inventário de rotas ficaria ilegível justamente nas rotas
 * aninhadas.
 */
const PARAM_GROUP = /\(\?:\\\/\(\[\^\\?\/\]\+\?\)\)/g;

/**
 * Caminho de montagem de um sub-router a partir da `regexp` da camada.
 * `fast_slash` (montado em `/`) → ''. Parâmetros voltam como `:nome` usando as
 * `keys` da camada, na ordem em que aparecem.
 */
export function mountPathOf(layer: ExpressLayer): string {
  const regexp = layer.regexp;
  if (!regexp || regexp.fast_slash) return '';
  const keys = layer.keys ?? [];
  let index = 0;
  const source = regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(PARAM_GROUP, () => `/:${String(keys[index++]?.name ?? 'param')}`)
    .replace(/\\\//g, '/');
  return source === '/' ? '' : source;
}

function joinPaths(prefix: string, path: string): string {
  const joined = `${prefix}${path}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined || '/';
}

/** Célula declarada em QUALQUER handler da rota (o guard pode não ser o último). */
function cellOfRoute(route: NonNullable<ExpressLayer['route']>): PermissionMetadata | undefined {
  for (const layer of route.stack ?? []) {
    const cell = readPermissionMetadata(layer.handle);
    if (cell) return cell;
  }
  return undefined;
}

function methodsOf(route: NonNullable<ExpressLayer['route']>): string[] {
  const methods = Object.keys(route.methods ?? {}).filter((m) => route.methods?.[m]);
  return methods.length > 0 ? methods.map((m) => m.toUpperCase()) : ['USE'];
}

function walk(layers: ExpressLayer[], prefix: string, out: ScannedRoute[]): void {
  for (const layer of layers) {
    if (layer.route) {
      const cell = cellOfRoute(layer.route);
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path ?? ''];
      for (const path of paths) {
        for (const method of methodsOf(layer.route)) {
          out.push({ method, path: joinPaths(prefix, path), ...(cell ? { cell } : {}) });
        }
      }
      continue;
    }
    const nested = stackOf(layer.handle);
    if (nested.length > 0) {
      walk(nested, joinPaths(prefix, mountPathOf(layer)), out);
      continue;
    }
    // Middleware montado com célula (ex.: `app.use('/api/docs', requirePermission(...))`)
    // é endpoint para efeito de catálogo: sem isso a família some da matriz.
    const cell = readPermissionMetadata(layer.handle);
    if (cell) out.push({ method: 'USE', path: joinPaths(prefix, mountPathOf(layer)) || '/', cell });
  }
}

/** Todas as rotas registradas, com a célula declarada quando houver. */
export function scanExpressRouter(app: Express | Router): ScannedRoute[] {
  const routes: ScannedRoute[] = [];
  walk(stackOf(app), '', routes);
  return routes;
}

/** Células distintas declaradas na varredura — a entrada do `syncCatalog`. */
export function declaredCells(routes: ScannedRoute[]): PermissionMetadata[] {
  const byKey = new Map<string, PermissionMetadata>();
  for (const route of routes) {
    if (!route.cell) continue;
    const key = `${route.cell.resource}:${route.cell.action}`;
    if (!byKey.has(key)) byKey.set(key, route.cell);
  }
  // Comparação de string CRUA (não `localeCompare`): a ordem alimenta o
  // catálogo e o arquivo de paridade do CI, e o locale da máquina não pode
  // mudar o resultado — `localeCompare` ordena `worker_pii` antes de `worker:`
  // em pt-BR e depois em C.
  return [...byKey.values()].sort((a, b) => {
    const left = `${a.resource}:${a.action}`;
    const right = `${b.resource}:${b.action}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Rotas do domínio governado que NÃO declararam célula — a lista que o teste de
 * rotas imprime ao falhar (spec: "o teste falha listando a rota").
 */
export function undeclaredRoutes(
  routes: ScannedRoute[],
  isGoverned: (route: ScannedRoute) => boolean,
): ScannedRoute[] {
  return routes.filter((route) => !route.cell && isGoverned(route));
}
