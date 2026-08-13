/**
 * Caminhos de ERRO dos endpoints destrutivos de paciente, contra PRODUÇÃO.
 *
 * Estes existem por um motivo específico: `DELETE /api/admin/patients/:id` apaga
 * paciente em produção. A única coisa entre ele e dado real de gente é a trava
 * `is_test`. Um teste unitário prova a trava no código; ESTE prova a trava **no
 * ar**, contra o serviço que está rodando agora — que é onde ela importa.
 *
 * Nenhum destes testes tem efeito colateral: todos exercitam a RECUSA. O caso
 * mais forte pega um paciente REAL da lista e tenta apagá-lo, esperando 409.
 * Se algum dia o guard sumir num refactor, este teste fica vermelho às 3h da
 * manhã, antes de alguém perder dado.
 *
 * Ordem de validação confirmada no AdminPatientsController:
 *   1. `patientIdSchema` (uuid) → 400 antes de tocar no banco
 *   2. paciente inexistente → 404
 *   3. paciente existe mas `is_test = false` → 409 NOT_A_TEST_PATIENT
 */
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';
import { PROD_API_URL } from '../src/support/env';

const BOGUS_UUID = '00000000-0000-4000-8000-000000000000';

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await newAdminApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

/** Anota status+erro no relatório (vira linha de evidência no email). */
async function anotar(res: { status: () => number; json: () => Promise<unknown> }, esperado: number) {
  const status = res.status();
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} code=${body?.code ?? '-'} (esperado ${esperado})`,
  });
  return { status, body };
}

test('[@route:DELETE /api/admin/patients/:id @depth:error] paciente REAL não pode ser apagado → 409', async () => {
  // Pega um paciente REAL da lista (read-only). Filtrar por `isTest` é essencial:
  // a jornada do paciente roda no MESMO horário e o registro mais novo da lista
  // pode ser o sintético dela. Sem o filtro, este teste apagava o paciente da
  // outra suíte e ainda dava "verde" pelo motivo errado (aconteceu na 1ª execução
  // da suíte completa).
  const lista = await api.get('/api/admin/patients?limit=20');
  expect(lista.status()).toBe(200);
  const { data } = (await lista.json()) as { data: Array<{ id: string; isTest?: boolean }> };
  const real = data.find((p) => p.isTest !== true);
  test.skip(!real, 'não há paciente real em produção para exercitar a trava');

  const realId = real!.id;
  const res = await api.delete(`/api/admin/patients/${realId}`);
  const { status, body } = await anotar(res, 409);

  expect(status, 'a trava is_test tem que recusar paciente real').toBe(409);
  expect(body.code).toBe('NOT_A_TEST_PATIENT');

  // E o paciente continua lá — a recusa não pode ter meio-apagado nada.
  const depois = await api.get(`/api/admin/patients/${realId}`);
  expect(depois.status(), 'o paciente real sumiu depois de um DELETE recusado').toBe(200);
});

test('[@route:DELETE /api/admin/patients/:id @depth:error] id não-UUID → 400', async () => {
  const res = await api.delete('/api/admin/patients/not-a-uuid');
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:DELETE /api/admin/patients/:id @depth:error] UUID inexistente → 404', async () => {
  const res = await api.delete(`/api/admin/patients/${BOGUS_UUID}`);
  const { status } = await anotar(res, 404);
  expect(status).toBe(404);
});

test('[@route:DELETE /api/admin/patients/:id @depth:auth] sem token → não apaga (401/403)', async () => {
  const anon = await request.newContext({ baseURL: PROD_API_URL });
  try {
    const res = await anon.delete(`/api/admin/patients/${BOGUS_UUID}`);
    const status = res.status();
    test.info().annotations.push({
      type: 'validacao',
      description: `status=${status} (esperado 401 ou 403)`,
    });
    expect([401, 403]).toContain(status);
  } finally {
    await anon.dispose();
  }
});

test('[@route:PATCH /api/admin/patients/:id/test-flag @depth:error] body sem isTest booleano → 400', async () => {
  const res = await api.patch(`/api/admin/patients/${BOGUS_UUID}/test-flag`, {
    data: { isTest: 'sim' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:PATCH /api/admin/patients/:id/test-flag @depth:error] UUID inexistente → 404', async () => {
  const res = await api.patch(`/api/admin/patients/${BOGUS_UUID}/test-flag`, {
    data: { isTest: true },
  });
  const { status } = await anotar(res, 404);
  expect(status).toBe(404);
});

test('[@route:PATCH /api/admin/patients/:id/test-flag @depth:auth] sem token → 401/403', async () => {
  const anon = await request.newContext({ baseURL: PROD_API_URL });
  try {
    const res = await anon.patch(`/api/admin/patients/${BOGUS_UUID}/test-flag`, {
      data: { isTest: true },
    });
    expect([401, 403]).toContain(res.status());
  } finally {
    await anon.dispose();
  }
});
