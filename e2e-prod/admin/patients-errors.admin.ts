/**
 * Caminho de ERRO — GET /api/admin/patients/:id (detalhe do paciente). Read-only.
 *
 * Ordem de validação confirmada em AdminPatientsController.getPatientById:
 *   1. `adminPatientParamsSchema.safeParse(req.params)` (id = z.string().uuid()) PRIMEIRO →
 *      "not-a-uuid" falha o Zod → 400 "Invalid params" antes de qualquer query.
 *   2. id UUID bem-formado → `getPatientByIdUseCase.execute` → `!result.found` → 404
 *      "Patient not found" (leitura pura, sem efeito colateral).
 *
 * Rota é `staffOnly` (requireStaff) — a conta admin passa.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';

const BOGUS_UUID = '00000000-0000-4000-8000-000000000000';

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await newAdminApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

test('[@route:GET /api/admin/patients/:id @depth:error] id não-UUID → 400 "Invalid params"', async () => {
  const res = await api.get('/api/admin/patients/not-a-uuid');
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Invalid params');
});

test('[@route:GET /api/admin/patients/:id @depth:error] UUID bem-formado inexistente → 404 "Patient not found"', async () => {
  const res = await api.get(`/api/admin/patients/${BOGUS_UUID}`);
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 404)`,
  });
  expect(status).toBe(404);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Patient not found');
});
