/**
 * Caminho de ERRO — PUT /api/admin/vacancies/:id (edição de vaga). Read-only por design.
 *
 * Ordem de validação confirmada em vacancyCrudHelpers.authorizeVacancyUpdate:
 *   1. `if (updates.status !== undefined && !CANONICAL_STATUSES.has(status))` → 400 ANTES de
 *      qualquer SELECT — status inválido barra mesmo com id inexistente (nenhum UPDATE roda).
 *   2. `SELECT status,is_draft,patient_id FROM job_postings WHERE id=$1` → 0 linhas → 404
 *      "Vacancy not found" ANTES do UPDATE. status gravável ('SEARCHING') passa o (1) e cai aqui.
 *
 * STATUS_GRAVAVEIS (estado-automatico-do-paciente F2) = SEARCHING, ON_HOLD, SUSPENDED, CLOSED. Usamos UUID bem-formado inexistente pra não arriscar 500 de cast.
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

test('[@route:PUT /api/admin/vacancies/:id @depth:error] status no corpo → 400 VACANCY_STATUS_NOT_WRITABLE antes de checar existência', async () => {
  // semaforo-da-vaga F4: ninguém grava `status`; o corpo é validado ANTES de buscar a vaga (como no main), então o 400 vale com id inexistente.
  const res = await api.put(`/api/admin/vacancies/${BOGUS_UUID}`, { data: { status: 'INVALID' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} code=${body?.code ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
  expect(body?.messages?.es).toContain('no se edita');
  expect(body?.messages?.['pt-BR']).toContain('não é editável');
});

test('[@route:PUT /api/admin/vacancies/:id @depth:error] status "válido" (antigo valor do ciclo de vida) + id inexistente → também 400, não 404', async () => {
  const res = await api.put(`/api/admin/vacancies/${BOGUS_UUID}`, { data: { status: 'SEARCHING' } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} code=${body?.code ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body?.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
});

test('[@route:PUT /api/admin/vacancies/:id @depth:error] campo (não-status) + id inexistente → 404 antes do UPDATE', async () => {
  const res = await api.put(`/api/admin/vacancies/${BOGUS_UUID}`, { data: { schedule: [] } });
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
