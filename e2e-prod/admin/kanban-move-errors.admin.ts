/**
 * Caminho de ERRO — PUT /api/admin/encuadres/:id/move (mover card no Kanban). Read-only por design.
 *
 * Ordem de validação confirmada em WJAFunnelController.moveEncuadre:
 *   1. `if (!targetStage || !validStages.includes(targetStage))` → 400 ANTES de qualquer SELECT
 *      — targetStage inválido barra mesmo com id inexistente (nenhuma transição persiste).
 *   2. `SELECT worker_id,job_posting_id FROM encuadres WHERE id=$1` → 0 linhas → 404
 *      "Encuadre not found" ANTES do UPDATE. targetStage válido ('INVITED') passa o (1) e cai aqui.
 *
 * validStages = INVITED, PRE_SCREENING, IN_PROGRESS, COMPLETED, QUALIFIED, IN_DOUBT, CONFIRMED,
 * SELECTED, REJECTED. Usamos UUID bem-formado inexistente pra não arriscar 500 de cast.
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

test('[@route:PUT /api/admin/encuadres/:id/move @depth:error] targetStage inválido → 400 antes de checar existência', async () => {
  const res = await api.put(`/api/admin/encuadres/${BOGUS_UUID}/move`, { data: { targetStage: 'INVALID' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toContain('targetStage must be one of:');
});

test('[@route:PUT /api/admin/encuadres/:id/move @depth:error] targetStage válido + id inexistente → 404 antes do UPDATE', async () => {
  const res = await api.put(`/api/admin/encuadres/${BOGUS_UUID}/move`, { data: { targetStage: 'INVITED' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 404)`,
  });
  expect(status).toBe(404);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Encuadre not found');
});
