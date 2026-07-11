/**
 * Smoke — health da API.
 *
 * 1) GET /health → 200: prova que a revisão de prod está de pé (liveness).
 * 2) GET /api/internal/vertex-health SEM credencial → 401/403: check NEGATIVO,
 *    read-only e seguro. Prova que o gate interno (InternalAuthMiddleware) rejeita
 *    quem não é Cloud Scheduler/Tasks. Um 200 aqui seria um buraco de segurança.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newApiContext } from '../src/support/api';

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await newApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

test('[@route:GET /health] liveness da API responde 200', async () => {
  const start = Date.now();
  const res = await api.get('/health');
  test.info().annotations.push({
    type: 'health',
    description: `status=${res.status()} durationMs=${Date.now() - start}`,
  });
  expect(res.status()).toBe(200);
});

test('[@route:GET /api/internal/vertex-health] gate interno rejeita não-autenticado (401/403)', async () => {
  const res = await api.get('/api/internal/vertex-health');
  test.info().annotations.push({
    type: 'authz-negativo',
    description: `status=${res.status()} (esperado 401 ou 403)`,
  });
  // Sem token OIDC / shared secret, o middleware tem que barrar. Nunca 200.
  expect([401, 403]).toContain(res.status());
});
