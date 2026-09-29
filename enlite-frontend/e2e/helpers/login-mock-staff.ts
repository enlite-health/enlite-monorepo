/**
 * Login de staff pelo MOCK do stack de CI (USE_MOCK_AUTH=true): mesmo contrato de
 * `kanban-pacientes.integration.e2e.ts` — Identity Toolkit forjado + só o header Authorization
 * trocado por `mock_*` (`installAuthInterceptors`), `/api/admin/auth/profile` mockado (não há linha
 * em `users`) e a entrada pela TELA de login (click + `keyboard.type`). O `uid` do MockUser é o
 * `principal.id` que a API grava como autor (`actor_uid`) — AuthMiddleware.ts:156-157.
 * Substitui `loginComoHumano` nos specs que precisam rodar no stack de CI (emulador não existe lá).
 */
import { expect, type Page, type Route } from '@playwright/test';
import { installAuthInterceptors, type MockUser } from './abac-stack-helper';

export async function loginComoStaffMock(page: Page, u: MockUser, displayName: string): Promise<void> {
  await installAuthInterceptors(page, u);
  // Registrado DEPOIS do swap de `/api/**`: Playwright prioriza a rota mais recente.
  await page.route('**/api/admin/auth/profile', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: u.uid, email: u.email, role: u.role, firstName: displayName, lastName: 'E2E', isActive: true, mustChangePassword: false },
      }),
    });
  });
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(u.email);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}
