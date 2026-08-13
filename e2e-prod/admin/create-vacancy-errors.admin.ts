/**
 * Caminho de ERRO — POST /api/admin/vacancies (criação de vaga). Read-only por design:
 * prova que prod REJEITA input inválido ANTES de qualquer INSERT.
 *
 * Ordem de validação confirmada em VacancyCrudController.createVacancy (worker-functions):
 *   1. `if (!patient_id || typeof patient_id !== 'string')` → 400 ANTES de tocar o banco.
 *   2. `SELECT id FROM patients WHERE id=$1 AND deleted_at IS NULL` → 0 linhas → 400 ANTES do
 *      `nextval(...)` e do INSERT em job_postings. Um UUID bem-formado inexistente cai aqui
 *      sem efeito colateral (a query é read-only e o fluxo dá return no 400).
 *
 * Segurança: usamos UUID BEM-FORMADO porém inexistente (não "not-a-uuid") pra não arriscar
 * um 500 de cast na coluna uuid. Nenhuma vaga é criada.
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

test('[@route:POST /api/admin/vacancies @depth:error] sem patient_id → 400 antes de gravar', async () => {
  const res = await api.post('/api/admin/vacancies', { data: { case_number: 999999 } });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toContain('patient_id é obrigatório');
});

test('[@route:POST /api/admin/vacancies @depth:error] patient_id UUID inexistente → 400 antes do INSERT', async () => {
  const res = await api.post('/api/admin/vacancies', {
    data: { case_number: 999999, patient_id: BOGUS_UUID },
  });
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado 400)`,
  });
  expect(status).toBe(400);
  expect(body).toHaveProperty('success', false);
  expect(body?.error).toContain('patient_id inválido');
});
