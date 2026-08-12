/**
 * Smoke — feed de jobs (scraper): GET /api/jobs.
 *
 * Endpoint do JobsController.getJobs (scraping externo com cache em memória, TTL 5min).
 * READ-ONLY: só valida que prod responde 200 e que o payload tem o formato real
 * { success: true, data: Job[], count: number, cached: boolean }. Lista vazia NÃO é
 * falha (scraper pode não ter retornado nada) — anota, não quebra o monitor.
 * Loga durationMs (é o endpoint mais lento — scraping quando o cache expira).
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

test('[@route:GET /api/jobs] feed de jobs responde 200 com shape', async () => {
  const start = Date.now();
  const res = await api.get('/api/jobs');
  const durationMs = Date.now() - start;

  expect(res.ok(), `esperava 2xx, veio ${res.status()}`).toBeTruthy();
  expect(res.status()).toBe(200);

  const body = await res.json();
  // Contrato do JobsController.getJobs: { success, data: Job[], count, cached }.
  expect(body).toHaveProperty('success', true);
  expect(Array.isArray(body.data), 'body.data deve ser array').toBeTruthy();
  expect(body).toHaveProperty('count');
  expect(body.count).toBe(body.data.length);

  test.info().annotations.push({
    type: 'jobs',
    description: `count=${body.count} cached=${body.cached} durationMs=${durationMs}`,
  });
});
