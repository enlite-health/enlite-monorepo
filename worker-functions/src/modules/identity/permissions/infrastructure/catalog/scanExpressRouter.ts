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
import {
  readExemptMetadata,
  readPermissionMetadata,
  type ExemptMetadata,
  type PermissionMetadata,
} from './permissionMetadata';
import { CELL_DESCRIPTION, cellKey, parseCellKey } from '../../domain/PermissionCell';

export interface ScannedRoute {
  /** Verbo em maiúsculas; `USE` para middleware montado como rota. */
  method: string;
  path: string;
  /** A PRIMEIRA célula declarada na rota — mantido por compatibilidade (era o único campo). */
  cell?: PermissionMetadata;
  /**
   * TODAS as células declaradas na rota, na ordem dos guards (`cells[0] === cell`).
   * Achado pós-#391 (spec 018, PR-8b): uma rota com guards ENCADEADOS de recursos
   * DIFERENTES (`patient_services:update` → `vacancy:update`) tinha a 2ª célula
   * invisível ao oráculo e à fixture, que só liam `cell` (a 1ª). `cellsOfRoute`
   * varre o array inteiro do handler e não só o primeiro achado.
   */
  cells?: PermissionMetadata[];
  /** Isenção declarada na montagem (`exemptHandler`) — governada sem célula. */
  exempt?: ExemptMetadata;
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

/**
 * TODAS as células declaradas nos handlers da rota, na ordem dos guards.
 * Dedup por `resource:action` — dois guards com a MESMA célula (ex.: literal
 * repetido por engano) não duplicam a entrada.
 */
function cellsOfRoute(route: NonNullable<ExpressLayer['route']>): PermissionMetadata[] {
  const seen = new Set<string>();
  const cells: PermissionMetadata[] = [];
  for (const layer of route.stack ?? []) {
    const cell = readPermissionMetadata(layer.handle);
    if (!cell) continue;
    const key = cellKey(cell.resource, cell.action);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(cell);
  }
  return cells;
}

/** Isenção declarada em QUALQUER handler da rota. */
function exemptOfRoute(route: NonNullable<ExpressLayer['route']>): ExemptMetadata | undefined {
  for (const layer of route.stack ?? []) {
    const exempt = readExemptMetadata(layer.handle);
    if (exempt) return exempt;
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
      const cells = cellsOfRoute(layer.route);
      const cell = cells[0];
      const exempt = exemptOfRoute(layer.route);
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path ?? ''];
      for (const path of paths) {
        for (const method of methodsOf(layer.route)) {
          out.push({ method, path: joinPaths(prefix, path), cells, ...(cell ? { cell } : {}), ...(exempt ? { exempt } : {}) });
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
    // Sem `|| '/'`: `joinPaths` já devolve '/' quando o resultado seria vazio.
    if (cell) out.push({ method: 'USE', path: joinPaths(prefix, mountPathOf(layer)), cell, cells: [cell] });
  }
}

/** Todas as rotas registradas, com a célula declarada quando houver. */
export function scanExpressRouter(app: Express | Router): ScannedRoute[] {
  const routes: ScannedRoute[] = [];
  walk(stackOf(app), '', routes);
  return routes;
}

/** Células distintas declaradas na varredura de ROTAS — uma das duas fontes
 * do catálogo; a outra é `cellsForaDeRota`, fundida pelo wiring. */
export function declaredCells(routes: ScannedRoute[]): PermissionMetadata[] {
  const byKey = new Map<string, PermissionMetadata>();
  for (const route of routes) {
    if (!route.cell) continue;
    const key = cellKey(route.cell.resource, route.cell.action);
    if (byKey.has(key)) continue;
    // A definição da célula entra AQUI, num lugar só, e não em 130 chamadas de
    // `perm.require(...)`: descrição repetida por rota diverge no dia em que
    // duas rotas exigem a mesma célula e alguém edita uma. O que a rota declarar
    // explicitamente ganha — a rota é quem conhece o caso particular.
    const description = route.cell.description ?? CELL_DESCRIPTION[key] ?? null;
    byKey.set(key, { ...route.cell, description });
  }
  // Comparação de string CRUA (não `localeCompare`): a ordem alimenta o
  // catálogo e o arquivo de paridade do CI, e o locale da máquina não pode
  // mudar o resultado — `localeCompare` ordena `worker_pii` antes de `worker:`
  // em pt-BR e depois em C.
  return [...byKey.values()].sort((a, b) => {
    const left = `${a.resource}:${a.action}`;
    const right = `${b.resource}:${b.action}`;
    // O ignore vai NO ARM do empate, não antes do `return`: na linha de cima ele
    // apagaria a statement inteira do relatório — inclusive os dois ramos REAIS
    // (-1 e 1) —, e o arquivo marcaria 100% com o comparador fora do
    // denominador. Empate é inalcançável porque o `byKey` acima já deduplica;
    // fica escrito mesmo assim porque comparador que não devolve 0 para iguais
    // é comparador errado, e quem mexer no dedup amanhã depende disso.
    return left < right ? -1 : left > right ? 1 : /* istanbul ignore next */ 0;
  });
}

/**
 * A SEGUNDA fonte do catálogo: as células que o código enforça ABAIXO da rota.
 *
 * ⚠️ Por que precisam existir fora da varredura — o buraco que o gate de
 * revisão achou no #253 e que teria detonado no flip:
 * `worker_contact:read` é decidida por `projectWorkerFields` no nível do CAMPO,
 * e `worker:disable` por `decidirTransicaoDeBaixa` no nível da OPERAÇÃO.
 * Nenhuma das duas é portão de rota — pendurá-las num `perm.require` faria a
 * rota INTEIRA exigi-las, que é o oposto do desenho (o Kanban abre com
 * `funnel:read`; só o NOME do prestador depende do contato).
 *
 * Sem esta fonte elas nunca entravam em `iam.permissions`: o sync só via o que
 * veio de rota. Medido no banco — as duas simplesmente NÃO EXISTIAM, nem pelo
 * seed. Consequência no dia da virada: `cells` deixa de ser `null` sem NUNCA
 * conter `worker_contact:read`, e a projeção redige nome e telefone para todo
 * mundo — inclusive o Acesso Master —, enquanto toda baixa é recusada por
 * `sem_celula_de_baixa`. É a armadilha "célula declarada ≠ célula existente"
 * dentro do PR que existe para implementá-la.
 *
 * A descrição escrita É a declaração: quem definiu o que a célula libera está
 * afirmando que ela existe. Fonte única, sem segunda lista para divergir.
 *
 * ⚠️ Recebe o que a varredura já achou e devolve só o COMPLEMENTO. A fusão fica
 * no wiring, e não aqui dentro, por um motivo que custa caro errar: o
 * `SyncPermissionCatalogUseCase` aborta fail-closed quando recebe lista VAZIA
 * ("a varredura não achou nenhuma célula"). Se esta função emitisse sempre,
 * varredura vazia chegaria ao sync como "4 células" e ele descontinuaria as 40
 * de rota de uma vez.
 */
export function cellsForaDeRota(jaDeclaradas: PermissionMetadata[]): PermissionMetadata[] {
  const vistas = new Set(jaDeclaradas.map((cell) => cellKey(cell.resource, cell.action)));
  const fora: PermissionMetadata[] = [];

  for (const [key, description] of Object.entries(CELL_DESCRIPTION)) {
    if (vistas.has(key)) continue;
    const parsed = parseCellKey(key);
    /* istanbul ignore next -- chave malformada em CELL_DESCRIPTION é erro de
       digitação; o guard existe para não empurrar lixo ao catálogo. */
    if (!parsed) continue;
    fora.push({ resource: parsed.resource, action: parsed.action, description });
  }

  return fora;
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
