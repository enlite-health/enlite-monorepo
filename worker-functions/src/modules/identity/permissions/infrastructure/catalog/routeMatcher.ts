/**
 * src/modules/identity/permissions/infrastructure/catalog/routeMatcher.ts
 *
 * Casa uma request (método + caminho concreto) com a rota REGISTRADA que a
 * varredura encontrou. É o que permite ao guard "deny-when-undeclared"
 * (task 3.4) responder a pergunta que o Express não responde antes do
 * despacho: *esta* request vai cair numa rota que declarou célula?
 *
 * Por que um matcher próprio em vez do `path-to-regexp`: a versão que existe
 * aqui é a transitiva do Express 4 (0.1.x, API antiga e sem garantia de
 * continuar existindo). Os caminhos que a varredura devolve são simples
 * (`/api/admin/workers/:id/documents/:type`), e casar por SEGMENTO é ~20 linhas
 * determinísticas, testáveis e sem dependência nova.
 *
 * ⚠️ O matcher é BEST-EFFORT de propósito, e o guard trata isso: caminho que
 * não casa com rota nenhuma volta `undefined` (a request vai virar 404 do
 * Express de qualquer jeito) e NUNCA vira negativa — inventar uma decisão a
 * partir de um caminho que não existe seria decidir sobre nada.
 */

import type { ScannedRoute } from './scanExpressRouter';

/**
 * Segmentos não-vazios do caminho (`/api/admin/users/` → ['api','admin','users']).
 *
 * Em MINÚSCULAS: o Express despacha sem sensibilidade a caixa (`case sensitive
 * routing` off por default), então casar sensível a caixa faria
 * `/API/admin/rota` não encontrar a rota que o Express vai atender — e o guard
 * que depende deste casamento deixaria a request passar sem opinar.
 */
function segmentsOf(path: string): string[] {
  return path.toLowerCase().split('/').filter((segment) => segment.length > 0);
}

/**
 * `exact` para verbo (a rota é aquele caminho); PREFIXO para `USE` — middleware
 * montado em `/api/docs` governa `/api/docs/swagger.json` também, e exigir
 * igualdade faria a família inteira escapar do guard.
 */
function matches(patternSegments: string[], pathSegments: string[], exact: boolean): boolean {
  if (exact ? patternSegments.length !== pathSegments.length : patternSegments.length > pathSegments.length) {
    return false;
  }
  return patternSegments.every(
    (segment, index) => segment.startsWith(':') || segment === pathSegments[index],
  );
}

export interface RouteIndex {
  /**
   * Primeira rota registrada que casa — a MESMA ordem que o Express usa para
   * despachar, porque a varredura devolve as camadas na ordem de registro.
   */
  find(method: string, path: string): ScannedRoute | undefined;
  /** Todas as rotas indexadas (o inventário que o boot loga e o e2e confere). */
  all(): ScannedRoute[];
}

export function buildRouteIndex(routes: ScannedRoute[]): RouteIndex {
  const compiled = routes.map((route) => ({ route, segments: segmentsOf(route.path) }));

  return {
    find(method: string, path: string): ScannedRoute | undefined {
      const wanted = method.toUpperCase();
      const pathSegments = segmentsOf(path);
      return compiled.find(({ route, segments }) => {
        if (route.method === 'USE') return matches(segments, pathSegments, false);
        return route.method === wanted && matches(segments, pathSegments, true);
      })?.route;
    },
    all: () => routes,
  };
}
