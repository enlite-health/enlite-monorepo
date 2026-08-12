/**
 * Smoke — API pública de vaga: GET /api/vacancies/:id.
 *
 * Endpoint que a página pública /vacantes/:id consome. Dois checks READ-ONLY:
 *  1) POSITIVO: pega o id da 1ª vaga do feed (/api/public/v1/jobs → data[0].id),
 *     faz GET /api/vacancies/:id → 200 + valida o shape real do PublicVacancyController:
 *     { success: true, data: { id, title, ... } }.
 *  2) NEGATIVO: GET /api/vacancies/<uuid válido inexistente> → 404 (prod rejeita de
 *     verdade, sem efeito colateral). Só o status agora; a mensagem exata fica pro
 *     inventário de fluxos.
 *
 * Feed vazio no run positivo → test.skip (não há id real pra exercitar).
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

test('[@route:GET /api/vacancies/:id] positivo: vaga real do feed responde 200 com shape', async () => {
  const feed = await api.get('/api/public/v1/jobs');
  expect(feed.ok(), `feed devia responder 2xx, veio ${feed.status()}`).toBeTruthy();
  const feedBody = await feed.json();
  const jobs: Array<{ id: string; title: string }> = feedBody.data ?? [];

  test.skip(
    jobs.length === 0,
    'feed público vazio — sem vaga ativa pra exercitar GET /api/vacancies/:id neste run',
  );

  const id = jobs[0]!.id;
  const start = Date.now();
  const res = await api.get(`/api/vacancies/${id}`);
  test.info().annotations.push({
    type: 'vaga-api',
    description: `id=${id} status=${res.status()} durationMs=${Date.now() - start}`,
  });

  expect(res.status()).toBe(200);
  const body = await res.json();
  // Contrato do PublicVacancyController.getById: { success: true, data: row }.
  expect(body).toHaveProperty('success', true);
  expect(body).toHaveProperty('data');
  // A página consome id + title da vaga — contrato mínimo tem que valer.
  expect(body.data).toHaveProperty('id', id);
  expect(body.data).toHaveProperty('title');
});

test('[@route:GET /api/vacancies/:id] negativo: uuid inexistente responde 404', async () => {
  // UUID sintaticamente válido mas garantidamente inexistente (all-zeros).
  const res = await api.get('/api/vacancies/00000000-0000-0000-0000-000000000000');
  test.info().annotations.push({
    type: 'vaga-api-404',
    description: `status=${res.status()} (esperado 404)`,
  });
  expect(res.status()).toBe(404);
});
