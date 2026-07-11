/**
 * Caminho de ERRO — PUT /api/admin/vacancies/:id (edição de vaga). Read-only por design.
 *
 * Ordem de validação confirmada em vacancyCrudHelpers.authorizeVacancyUpdate:
 *   1. `if (updates.status !== undefined && !CANONICAL_STATUSES.has(status))` → 400 ANTES de
 *      qualquer SELECT — status inválido barra mesmo com id inexistente (nenhum UPDATE roda).
 *   2. `SELECT status,is_draft,patient_id FROM job_postings WHERE id=$1` → 0 linhas → 404
 *      "Vacancy not found" ANTES do UPDATE. status canônico ('ACTIVE') passa o (1) e cai aqui.
 *
 * CANONICAL_STATUSES = SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE, PENDING_ACTIVATION,
 * ACTIVE, SUSPENDED, CLOSED. Usamos UUID bem-formado inexistente pra não arriscar 500 de cast.
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

test('[@route:PUT /api/admin/vacancies/:id @depth:error] status inválido → 400 antes de checar existência', async () => {
  const res = await api.put(`/api/admin/vacancies/${BOGUS_UUID}`, { data: { status: 'INVALID' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toContain('Invalid status value');
});

test('[@route:PUT /api/admin/vacancies/:id @depth:error] status válido + id inexistente → 404 antes do UPDATE', async () => {
  const res = await api.put(`/api/admin/vacancies/${BOGUS_UUID}`, { data: { status: 'ACTIVE' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 404)`,
  });
  expect(status).toBe(404);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toBe('Vacancy not found');
});
