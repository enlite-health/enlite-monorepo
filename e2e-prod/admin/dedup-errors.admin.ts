/**
 * Caminho de ERRO — Centro de Duplicados (/api/admin/dedup/*). Read-only por design.
 *
 * Ordem de validação confirmada em AdminDedupController:
 *   - executeMerge: `MergeBodySchema.safeParse(req.body)` PRIMEIRO → 400 (Zod) antes do use case.
 *     survivorId precisa ser UUID e absorbedIds min(1). Usamos survivorId="not-a-uuid" (formato
 *     inválido) — o Zod barra na borda, NENHUM merge roda. (Um survivorId UUID-válido-inexistente
 *     passaria o Zod e poderia dar 500 no use case — PROIBIDO; por isso só UUID inválido aqui.)
 *   - buildManualGroup: `ManualGroupBodySchema.safeParse` PRIMEIRO → ids array de UUID min(2).
 *     `["x"]` falha o min(2) → 400 com a mensagem "ids deve ter ao menos 2 elementos".
 *   - getGroupDetail: phoneNormalized presente → `GetDedupGroupDetailUseCase` retorna null pra
 *     telefone inexistente → 404 "Grupo não encontrado" (leitura, sem efeito colateral).
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

test('[@route:POST /api/admin/dedup/merge @depth:error] survivorId não-UUID + absorbedIds vazio → 400 (Zod) antes do merge', async () => {
  const res = await api.post('/api/admin/dedup/merge', {
    data: { survivorId: 'not-a-uuid', absorbedIds: [] },
  });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} (esperado 400 Zod)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
});

test('[@route:POST /api/admin/dedup/manual-group @depth:error] manual-group com 1 id → 400 "ids deve ter ao menos 2 elementos"', async () => {
  const res = await api.post('/api/admin/dedup/manual-group', { data: { ids: ['x'] } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} (esperado 400 Zod min 2)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  // A mensagem do min(2) vem no flatten do Zod (fieldErrors.ids).
  expect(JSON.stringify(body)).toContain('ids deve ter ao menos 2 elementos');
});

test('[@route:GET /api/admin/dedup/groups/:phoneNormalized @depth:error] group detail de telefone inexistente → 404 "Grupo não encontrado"', async () => {
  const res = await api.get('/api/admin/dedup/groups/000000000000');
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 404)`,
  });
  expect(status).toBe(404);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Grupo não encontrado');
});
