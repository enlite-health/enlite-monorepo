/**
 * Smoke — VALIDAÇÃO que barra ANTES de gravar (checks negativos, read-only).
 *
 * Manda body inválido em endpoints públicos de escrita e prova que prod devolve 400
 * SEM efeito colateral. Confirmado no código-fonte do backend que o 400 sai antes de
 * qualquer use case / write no banco:
 *  - WorkerControllerV2.initWorker: `if (!authUid || !email) → 400` (linha 57), antes
 *    de tocar repositório ou Twilio. Body `{}` → "Missing required fields: authUid, email".
 *  - ClaimController.start: valida authUid/email/phone e retorna 400 antes de startClaim
 *    .execute(). Body `{}` → "Missing required field: authUid".
 *
 * CUIDADO rate-limit: /api/auth/claim/start é 3/15min por IP (claimRoutes). Fazemos UMA
 * request só (sem novas requests ao claim neste arquivo). O 404 de GET /api/vacancies/:id
 * (uuid inexistente) já é coberto por public-vacancy-api.smoke.ts — não duplicamos aqui.
 *
 * GET /api/workers/lookup (WorkerControllerV2.lookupByEmail) valida a query ANTES do use
 * case: sem `email` → 400 "Missing required query parameter: email"; email sem @/. → 400
 * "Invalid email format". Endpoint é 10/min por IP; batemos 2 requests read-only. Mensagens
 * batidas contra o controller em 2026-07-11.
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

test('[@route:POST /api/workers/init @depth:error] body vazio é rejeitado com 400 antes de gravar', async () => {
  const res = await api.post('/api/workers/init', { data: {} });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  // Zod/guard barra: sem authUid+email não há candidato criado nem OTP disparado.
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
});

test('[@route:POST /api/auth/claim/start @depth:error] body inválido é rejeitado com 400 (1 request — rate-limit 3/15min)', async () => {
  // UMA request apenas: o endpoint é 3/15min por IP. 400 sai antes de startClaim.execute().
  const res = await api.post('/api/auth/claim/start', { data: {} });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  // Mensagem exata do guard (mesma request — NÃO fazemos outra ao claim/start).
  expect(body).toHaveProperty('error', 'Missing required field: authUid');
});

test('[@route:GET /api/workers/lookup @depth:error] sem email é rejeitado com 400', async () => {
  const res = await api.get('/api/workers/lookup');
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body).toHaveProperty('error', 'Missing required query parameter: email');
});

test('[@route:GET /api/workers/lookup @depth:error] email com formato inválido é rejeitado com 400', async () => {
  // Sem "@" nem "." → o guard barra antes do use case (nenhum acesso a repositório).
  const res = await api.get('/api/workers/lookup', { params: { email: 'no-es-email' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body).toHaveProperty('error', 'Invalid email format');
});
