/**
 * Smoke — CAMINHO DE ERRO da página pública de vaga: /vacantes/<uuid inexistente>.
 *
 * Navega a página pública com um UUID sintaticamente válido mas garantidamente
 * inexistente. A página faz GET /api/vacancies/:id; a API responde 404, o
 * PublicApiService.getVacancy lança VacancyNotFoundError e a página pinta o card
 * "Vacante no encontrada" (publicVacancy.notFound.title, es.json). READ-ONLY: só um
 * GET que 404-a, sem efeito colateral. Zero mock.
 *
 * CONTEXTO (achado 2026-07-11): esse render dependia do header CORS na resposta de ERRO
 * da API. O header custom `x-e2e-synthetic` que a suíte injetava forçava preflight e as
 * respostas 404 não traziam ACAO → o fetch cross-origin do browser falhava (net::ERR_FAILED)
 * e o front caía num branch de erro genérico, não no NotFound. Esse header foi REMOVIDO.
 * Verificado por evidência (curl com Origin da app) que o 404 de prod agora traz
 * `access-control-allow-origin: <origin da app>` — logo o browser lê o 404 e o
 * VacancyNotFoundError dispara o card certo. Este teste é a prova viva disso.
 */
import { test, expect } from '@playwright/test';

test('[@route:/vacantes/:id @depth:error] uuid inexistente mostra card "Vacante no encontrada"', async ({ page }) => {
  await page.goto('/vacantes/00000000-0000-0000-0000-000000000000');

  // Heading nível 2 do VacancyNotFound (PublicVacancyPage). Web-first absorve o skeleton
  // de loading antes do 404 resolver.
  await expect(
    page.getByRole('heading', { name: 'Vacante no encontrada' }),
  ).toBeVisible();
});
