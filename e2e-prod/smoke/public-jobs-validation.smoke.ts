/**
 * Smoke — validação do feed público: GET /api/public/v1/jobs com query inválida (read-only).
 *
 * O feed valida os query params com Zod (PublicJobsQuerySchema) ANTES de consultar o banco:
 *  - `country` passa por `.regex(/^[A-Z]{2}$/)` → 3+ letras (ex.: XYZ) falha → 400.
 *  - `worker_sex` é `z.enum(['FEMALE','MALE','BOTH'])` → valor fora do enum → 400.
 * Provar que prod REJEITA input ruro é read-only e sem efeito colateral (o safeParse falha
 * antes do use case). Complementa o caminho positivo em public-jobs-feed.smoke.ts.
 *
 * Confirmado contra prod (2026-07-11): country=XYZ → 400; worker_sex=INVALID → 400.
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

test('[@route:GET /api/public/v1/jobs @depth:error] country inválido (não-ISO2) responde 400', async () => {
  const res = await api.get('/api/public/v1/jobs?country=XYZ');
  const status = res.status();
  test.info().annotations.push({
    type: 'validacao-feed',
    description: `country=XYZ → ${status} (esperado 400)`,
  });
  // Zod barra: country tem que casar /^[A-Z]{2}$/ — "XYZ" (3 letras) é inválido.
  expect(status).toBe(400);
});

test('[@route:GET /api/public/v1/jobs @depth:error] worker_sex fora do enum responde 400', async () => {
  const res = await api.get('/api/public/v1/jobs?worker_sex=INVALID');
  const status = res.status();
  test.info().annotations.push({
    type: 'validacao-feed',
    description: `worker_sex=INVALID → ${status} (esperado 400)`,
  });
  // Zod enum ['FEMALE','MALE','BOTH'] rejeita 'INVALID'.
  expect(status).toBe(400);
});
