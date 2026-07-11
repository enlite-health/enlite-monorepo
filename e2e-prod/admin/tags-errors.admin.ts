/**
 * Caminho de ERRO — POST /api/admin/worker-tags (criar tag de worker). Read-only por design.
 *
 * Ordem de validação confirmada em AdminTagCatalogController.create:
 *   `CreateTagSchema.safeParse(req.body)` PRIMEIRO → 400 "Invalid body" antes de qualquer INSERT.
 *   CreateTagSchema = { name: string().min(1).max(100), color: string().regex(HEX_COLOR_REGEX) }.
 *   `{name:"",color:"xxx"}` falha min(1) do name E o regex de hex do color → Zod barra, sem write.
 *
 * Rota é `adminOnly` (requireAdmin) — a conta de teste é admin e passa o RBAC.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await newAdminApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

test('[@route:POST /api/admin/worker-tags @depth:error] body inválido (name vazio + color não-hex) → 400 "Invalid body"', async () => {
  const res = await api.post('/api/admin/worker-tags', { data: { name: '', color: 'xxx' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Invalid body');
});
