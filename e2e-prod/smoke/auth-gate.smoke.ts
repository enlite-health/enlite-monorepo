/**
 * Smoke — PERÍMETRO DE AUTH (checks negativos, read-only).
 *
 * Para CADA endpoint protegido, faz a request SEM Authorization e prova que prod
 * responde 401/403. É o monitor do perímetro de segurança: um 200 aqui seria um
 * buraco (endpoint de admin/analytics/worker vazando sem token). READ-ONLY e seguro
 * — o middleware (AuthMiddleware / InternalAuthMiddleware) barra ANTES de qualquer
 * lógica ou efeito colateral. 1 request por endpoint, sem rate-limit.
 *
 * Códigos reais confirmados contra prod (2026-07-11):
 *  - GETs protegidos por requireAuth/requireStaff/requireAdmin sem token → 401.
 *  - POST /api/internal/outbox/process (internalAuthMiddleware) sem token → 403.
 * O assert aceita [401,403] pra ambos os regimes (autz vs autn) sem ficar frágil.
 *
 * Tags literais no array ENDPOINTS abaixo → o gate de cobertura (que lê o SOURCE)
 * enxerga cada tag de rota mesmo o teste sendo data-driven.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newApiContext } from '../src/support/api';

type Method = 'get' | 'post';

interface ProtectedEndpoint {
  /** Título/tag literal — precisa aparecer no source pro coverage-gate casar. */
  tag: string;
  method: Method;
  path: string;
}

// SÓ verbos seguros: GETs (idempotentes) + o único POST cujo gate barra antes de
// processar (outbox/process → 403 sem token, nada é despachado).
const ENDPOINTS: readonly ProtectedEndpoint[] = [
  { tag: '[@route:GET /api/admin/workers @depth:auth]', method: 'get', path: '/api/admin/workers' },
  { tag: '[@route:GET /api/admin/workers/stats @depth:auth]', method: 'get', path: '/api/admin/workers/stats' },
  { tag: '[@route:GET /api/admin/patients @depth:auth]', method: 'get', path: '/api/admin/patients' },
  { tag: '[@route:GET /api/admin/vacancies @depth:auth]', method: 'get', path: '/api/admin/vacancies' },
  { tag: '[@route:GET /api/admin/dedup/groups @depth:auth]', method: 'get', path: '/api/admin/dedup/groups' },
  { tag: '[@route:GET /api/admin/recruitment/health @depth:auth]', method: 'get', path: '/api/admin/recruitment/health' },
  { tag: '[@route:GET /api/admin/users @depth:auth]', method: 'get', path: '/api/admin/users' },
  { tag: '[@route:GET /analytics/workers @depth:auth]', method: 'get', path: '/analytics/workers' },
  { tag: '[@route:GET /analytics/dashboard/global @depth:auth]', method: 'get', path: '/analytics/dashboard/global' },
  { tag: '[@route:GET /api/workers/me @depth:auth]', method: 'get', path: '/api/workers/me' },
  { tag: '[@route:GET /api/workers/me/documents @depth:auth]', method: 'get', path: '/api/workers/me/documents' },
  { tag: '[@route:GET /api/workers/status-dashboard @depth:auth]', method: 'get', path: '/api/workers/status-dashboard' },
  { tag: '[@route:POST /api/internal/outbox/process @depth:auth]', method: 'post', path: '/api/internal/outbox/process' },

  // ── Perímetro adicional (confirmado no router real + probado em prod 2026-07-11: cada um
  //    devolve 401 sem token; rota inexistente sob /api/admin devolve 404, provando que o
  //    401 é hit real de rota protegida, não fallback). Todos read-only, staff/auth-gated.
  { tag: '[@route:GET /api/admin/vacancies/stats @depth:auth]', method: 'get', path: '/api/admin/vacancies/stats' },
  { tag: '[@route:GET /api/admin/workers/filter-options @depth:auth]', method: 'get', path: '/api/admin/workers/filter-options' },
  { tag: '[@route:GET /api/admin/patients/stats @depth:auth]', method: 'get', path: '/api/admin/patients/stats' },
  { tag: '[@route:GET /analytics/dashboard/management @depth:auth]', method: 'get', path: '/analytics/dashboard/management' },
  { tag: '[@route:GET /api/admin/worker-tags @depth:auth]', method: 'get', path: '/api/admin/worker-tags' },
  { tag: '[@route:GET /api/admin/messaging/templates @depth:auth]', method: 'get', path: '/api/admin/messaging/templates' },
  { tag: '[@route:GET /api/admin/dedup/history @depth:auth]', method: 'get', path: '/api/admin/dedup/history' },
  { tag: '[@route:GET /api/workers/me/availability @depth:auth]', method: 'get', path: '/api/workers/me/availability' },
  { tag: '[@route:GET /api/admin/recruitment/progreso @depth:auth]', method: 'get', path: '/api/admin/recruitment/progreso' },
];

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await newApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

for (const ep of ENDPOINTS) {
  test(`${ep.tag} sem Authorization é barrado (401/403)`, async () => {
    const res = ep.method === 'post' ? await api.post(ep.path) : await api.get(ep.path);
    const status = res.status();
    test.info().annotations.push({
      type: 'authz-negativo',
      description: `${ep.method.toUpperCase()} ${ep.path} → ${status} (esperado 401 ou 403)`,
    });
    // Nunca 200/2xx: endpoint protegido não pode responder dado sem token.
    expect([401, 403]).toContain(status);
  });
}
