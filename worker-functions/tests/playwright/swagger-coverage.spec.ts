/**
 * Cobertura OpenAPI — garante que:
 *   1. Toda rota Express registrada está documentada no spec
 *   2. Toda operação documentada tem metadata mínima (summary, description, tags, responses)
 *   3. Toda operação que não é pública tem security scheme definido
 *
 * Se este teste falhar, alguém adicionou uma rota e esqueceu de criar/atualizar
 * o arquivo correspondente em src/shared/openapi/registrations/.
 */

import { test, expect, request } from '@playwright/test';

// Rotas que NÃO devem aparecer no OpenAPI (infra de teste / debug).
const DOC_INFRA_PREFIXES = ['/api/docs', '/mock-auth', '/api/test/auth'];
const PUBLIC_PATHS = new Set<string>([
  'GET /health',
  'GET /api/jobs',
  'GET /api/public/v1/jobs',
  'GET /api/workers/lookup',
  'POST /api/workers/init',
  'GET /api/vacancies/{id}',
  'POST /api/admin/setup',
  'GET /api/webhooks/clickup/patient/_health',
  'GET /api/webhooks-test/clickup/patient/_health',
]);

interface ExpressRouteInfo {
  method: string;
  expressPath: string;
  openApiPath: string;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags?: Array<{ name: string; description?: string }>;
  components?: { securitySchemes?: Record<string, unknown> };
}

let expressRoutes: ExpressRouteInfo[];
let doc: OpenApiDoc;

test.beforeAll(async () => {
  const ctx = await request.newContext();

  const routesRes = await ctx.get('/api/docs/_routes');
  expect(routesRes.status(), 'GET /api/docs/_routes should return 200').toBe(200);
  const routesBody = (await routesRes.json()) as { count: number; routes: ExpressRouteInfo[] };
  expressRoutes = routesBody.routes;
  expect(expressRoutes.length).toBeGreaterThan(100);

  const specRes = await ctx.get('/api/docs/openapi.json');
  expect(specRes.status(), 'GET /api/docs/openapi.json should return 200').toBe(200);
  doc = (await specRes.json()) as OpenApiDoc;
  expect(doc.paths).toBeTruthy();
});

test('toda rota Express está documentada no OpenAPI', () => {
  const missing: string[] = [];

  for (const r of expressRoutes) {
    if (DOC_INFRA_PREFIXES.some((p) => r.expressPath.startsWith(p))) continue;
    const method = r.method.toLowerCase();
    const path = r.openApiPath;
    const op = doc.paths[path]?.[method];
    if (!op) {
      missing.push(`${r.method} ${path}`);
    }
  }

  expect(missing, `Rotas Express SEM entrada em OpenAPI: \n${missing.join('\n')}`).toEqual([]);
});

test('toda operação OpenAPI corresponde a uma rota Express', () => {
  const expressKeys = new Set<string>(
    expressRoutes.map((r) => `${r.method} ${r.openApiPath}`),
  );

  const orphans: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (!expressKeys.has(key)) {
        orphans.push(key);
      }
    }
  }

  expect(orphans, `Operações OpenAPI sem rota Express correspondente:\n${orphans.join('\n')}`).toEqual([]);
});

test('toda operação tem summary, description e tags preenchidos', () => {
  const violations: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const id = `${method.toUpperCase()} ${path}`;

      if (!op.summary || op.summary.trim().length < 3) {
        violations.push(`${id} → summary vazio/curto`);
      }
      if (!op.description || op.description.trim().length < 20) {
        violations.push(`${id} → description ausente ou < 20 chars`);
      }
      if (!op.tags || op.tags.length === 0) {
        violations.push(`${id} → sem tags`);
      }
    }
  }

  expect(violations, `Operações sem metadata mínima:\n${violations.join('\n')}`).toEqual([]);
});

test('toda operação documenta pelo menos um response 2xx e o envelope de erro', () => {
  const violations: string[] = [];

  // Liveness/health probes legitimamente nunca retornam erro (só 200 ou crash).
  const livenessProbes = new Set([
    'GET /health',
    'GET /api/webhooks/clickup/patient/_health',
    'GET /api/webhooks-test/clickup/patient/_health',
  ]);

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const id = `${method.toUpperCase()} ${path}`;
      const codes = Object.keys(op.responses ?? {});

      const has2xx = codes.some((c) => c.startsWith('2'));
      const hasErr = codes.some((c) => c.startsWith('4') || c.startsWith('5'));

      if (!has2xx) violations.push(`${id} → sem response 2xx`);
      if (!hasErr && !livenessProbes.has(id)) {
        violations.push(`${id} → sem response 4xx/5xx`);
      }
    }
  }

  expect(violations, `Operações sem responses adequados:\n${violations.join('\n')}`).toEqual([]);
});

test('operações não-públicas têm security scheme definido', () => {
  const violations: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const id = `${method.toUpperCase()} ${path}`;

      if (PUBLIC_PATHS.has(id)) continue;

      const sec = op.security;
      const hasSecurity = Array.isArray(sec) && sec.length > 0 && Object.keys(sec[0]).length > 0;
      if (!hasSecurity) {
        violations.push(`${id} → sem security scheme (esperado firebaseAuth/internalApiKey/partnerKey/etc)`);
      }
    }
  }

  expect(violations, `Operações privadas sem auth declarada:\n${violations.join('\n')}`).toEqual([]);
});

test('toda tag usada em operações existe na lista global de tags', () => {
  const knownTags = new Set((doc.tags ?? []).map((t) => t.name));
  const violations: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      for (const tag of op.tags ?? []) {
        if (!knownTags.has(tag)) {
          violations.push(`${method.toUpperCase()} ${path} usa tag "${tag}" que não está na lista global`);
        }
      }
    }
  }

  expect(violations, `Tags fora da ordem definida em document.ts:\n${violations.join('\n')}`).toEqual([]);
});

test('todos os security schemes referenciados existem em components', () => {
  const declared = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
  const violations: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      for (const entry of op.security ?? []) {
        for (const name of Object.keys(entry)) {
          if (!declared.has(name)) {
            violations.push(`${method.toUpperCase()} ${path} usa security "${name}" não declarado`);
          }
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
