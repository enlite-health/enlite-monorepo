/**
 * Login único (T407): depois do formulário, `LoginPage` decide o destino por `GET /v1/me/areas`
 * (`useAreaDestination`). A rota vive em `/v1/me/*`, FORA de `/api/**`, então os swaps de token
 * dos specs não a cobrem — com o ID token forjado ela leva 401 e a tela fica em `/login`.
 *
 * Duas formas, as mesmas que a suíte já usa para `/v1/me/authz`:
 *  - `swapAreasComToken`: a request segue para a API REAL, só o Authorization é trocado (stack com API de pé);
 *  - `mockAreasDoPainel`: contrato de ACESSO (não dado de negócio) fixado em "só a área admin", para os specs
 *    de config mockada, sem API. Mesmo molde do mock de `/v1/me/authz`.
 */
import type { Page, Route } from '@playwright/test';

export async function swapAreasComToken(page: Page, mockToken: string): Promise<void> {
  await page.route('**/v1/me/areas', async (route: Route) => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  });
}

export async function mockAreasDoPainel(page: Page): Promise<void> {
  await page.route('**/v1/me/areas', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ areas: [{ area: 'admin', role: 'admin', entryRoute: '/admin' }], tokenRefreshRequired: false }),
    }),
  );
}
