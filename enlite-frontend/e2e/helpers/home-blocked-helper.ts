/**
 * home-blocked-helper — prova do bloqueio da home (096): prestador com cadastro INCOMPLETO vê UM bloco genérico no lugar do mapa e da
 * lista de vagas, sem listar o que falta, sem o banner antigo e SEM chamar `GET /api/workers/me/jobs`. A completude vem da MASSA
 * semeada (backend real, `fn_worker_missing_fields`), nunca de stub de `/me`.
 */
import { expect, type Page } from '@playwright/test';

/** Começa a contar as chamadas a `/api/workers/me/jobs`; chamar ANTES do `goto`. Devolve o contador. */
export function countJobsRouteCalls(page: Page): () => number {
  let calls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/workers/me/jobs')) calls += 1;
  });
  return () => calls;
}

export async function expectHomeBlocked(page: Page, jobsRouteCalls: () => number): Promise<void> {
  await expect(page.getByTestId('complete-profile-notice')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Completá tu registro para ver las vacantes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Completar registro' })).toBeVisible();
  await expect(page.getByTestId('profile-notice-item')).toHaveCount(0);
  await expect(page.locator('#jobs-section')).toHaveCount(0);
  await expect(page.getByTestId('jobs-radius-section')).toHaveCount(0);
  await expect(page.getByTestId('job-card')).toHaveCount(0);
  await expect(page.getByTestId('complete-registration-banner')).toHaveCount(0);
  expect(jobsRouteCalls(), 'cadastro incompleto não chama /api/workers/me/jobs').toBe(0);
}
