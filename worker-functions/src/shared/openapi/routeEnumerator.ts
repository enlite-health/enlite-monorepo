import type { Application, IRouter } from 'express';

export interface EnumeratedRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  path: string;
}

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
type Method = (typeof VALID_METHODS)[number];

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
  name?: string;
  handle?: IRouter & { stack?: ExpressLayer[] };
  regexp?: RegExp;
  // Express 4 stores the prefix string here when a router is mounted via app.use(prefix, router)
  // (undocumented but stable)
  // see https://github.com/expressjs/express/issues/3308
  // and https://github.com/expressjs/express/blob/4.x/lib/router/index.js
  // It's the regexp source we have to parse.
}

/**
 * Walks app._router.stack recursively and returns every (method, path) registered.
 * Used by Playwright coverage test to assert that every Express route has an
 * OpenAPI entry.
 *
 * Notes:
 * - Express path-to-regexp params are preserved (`/foo/:id`).
 * - Mounted sub-routers have their mount prefix prepended.
 * - Skips internal Express middleware (no `route` and no nested `handle.stack`).
 */
export function enumerateExpressRoutes(app: Application): EnumeratedRoute[] {
  const routes: EnumeratedRoute[] = [];
  const stack = (app as unknown as { _router?: { stack?: ExpressLayer[] } })._router?.stack;
  if (!stack) return routes;

  walk(stack, '', routes);
  return dedupe(routes);
}

function walk(stack: ExpressLayer[], prefix: string, out: EnumeratedRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = combine(prefix, layer.route.path);
      for (const m of Object.keys(layer.route.methods)) {
        const method = m.toUpperCase();
        if (isMethod(method) && layer.route.methods[m]) {
          out.push({ method, path });
        }
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      const subPrefix = extractMountPrefix(layer.regexp);
      walk(layer.handle.stack, combine(prefix, subPrefix), out);
    }
  }
}

function combine(prefix: string, path: string): string {
  if (!prefix) return path;
  if (!path || path === '/') return prefix;
  const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const b = path.startsWith('/') ? path : `/${path}`;
  return `${a}${b}`;
}

/**
 * Express 4 mounts sub-routers via a regexp. The regexp source for `app.use('/api/admin/patients', r)`
 * looks like: `/^\/api\/admin\/patients\/?(?=\/|$)/i` — we reverse-engineer the prefix from `regexp.source`.
 */
function extractMountPrefix(regexp?: RegExp): string {
  if (!regexp) return '';
  const src = regexp.source;
  // ^\/foo\/bar\/?(?=\/|$)  →  /foo/bar
  const match = src.match(/^\^\\?\/(.*?)\\\/\?\(\?=\\\/\|\$\)/);
  if (!match) {
    if (src === '^\\/?(?=\\/|$)' || src === '^\\/?$') return '';
    return '';
  }
  return '/' + match[1].replace(/\\\//g, '/');
}

function isMethod(m: string): m is Method {
  return (VALID_METHODS as readonly string[]).includes(m);
}

function dedupe(routes: EnumeratedRoute[]): EnumeratedRoute[] {
  const seen = new Set<string>();
  const out: EnumeratedRoute[] = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Normaliza um path Express para o formato OpenAPI: `/foo/:id` → `/foo/{id}`.
 * Usado pelo teste de cobertura para casar rotas Express com paths do spec.
 */
export function expressPathToOpenApi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
