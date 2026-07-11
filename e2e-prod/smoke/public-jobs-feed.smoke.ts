/**
 * Smoke — feed público de vagas: GET /api/public/v1/jobs.
 *
 * É o coração do funil público (alimenta a página de vaga e o feed WordPress).
 * READ-ONLY: só valida que prod responde 200 e que o payload tem o formato
 * esperado ({ success, data: [...] }). Feed vazio NÃO é falha (pode não haver
 * vaga ativa às 3h) — anota via annotation, não quebra o monitor.
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

test('[@route:GET /api/public/v1/jobs] feed público responde 200 com lista', async () => {
  const start = Date.now();
  const res = await api.get('/api/public/v1/jobs');
  const durationMs = Date.now() - start;

  expect(res.ok(), `esperava 2xx, veio ${res.status()}`).toBeTruthy();
  expect(res.status()).toBe(200);

  const body = await res.json();
  // Contrato do PublicJobsController: { success: true, data: PublicJobDto[] }
  expect(body).toHaveProperty('success', true);
  expect(Array.isArray(body.data), 'body.data deve ser array').toBeTruthy();

  const count: number = body.data.length;
  test.info().annotations.push({
    type: 'feed',
    description: `count=${count} durationMs=${durationMs}`,
  });

  if (count === 0) {
    test.info().annotations.push({
      type: 'nota',
      description: 'feed vazio — sem vaga ativa no momento; não é falha do monitor',
    });
  } else {
    // Se há vaga, o contrato mínimo (id + title) tem que valer — é o que a página consome.
    const first = body.data[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
  }
});
