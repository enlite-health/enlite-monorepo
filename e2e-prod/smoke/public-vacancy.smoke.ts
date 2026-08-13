/**
 * Smoke — página pública de vaga: /vacantes/:id.
 *
 * Pega uma vaga REAL do feed e navega a página pública dela como um candidato faria.
 * Assere que o heading principal (h1 "Vacante: ...") renderiza — prova que o SPA
 * carregou, buscou /api/vacancies/:id e pintou conteúdo (não é tela branca/erro).
 * READ-ONLY: só GET/render, nenhum clique em "Postularse".
 * Feed vazio → test.skip com annotation (não há id pra exercitar).
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

test('[@route:/vacantes/:id] renderiza vaga pública real do feed', async ({ page }) => {
  const res = await api.get('/api/public/v1/jobs');
  expect(res.ok(), `feed devia responder 2xx, veio ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const jobs: Array<{ id: string; title: string }> = body.data ?? [];

  test.skip(
    jobs.length === 0,
    'feed público vazio — sem vaga ativa pra exercitar /vacantes/:id neste run',
  );

  const job = jobs[0]!;
  test.info().annotations.push({
    type: 'vaga',
    description: `id=${job.id} title=${job.title}`,
  });

  await page.goto(`/vacantes/${job.id}`);

  // Heading nível 1 = "Vacante: <título>" (PublicVacancyPage). Web-first assertion,
  // tolerante a cold start via expect.timeout do config.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(/Vacante/i);

  // Sanidade extra: NÃO caiu na tela de "no encontrada".
  await expect(
    page.getByText('Vacante no encontrada', { exact: false }),
  ).toHaveCount(0);
});
