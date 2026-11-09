/**
 * F4 (T409) — o seletor de área (tira dentro do <main> do AdminLayout) NÃO pode ficar por cima de modal.
 * Causa medida: a tira era `sticky z-20` e o modal (`fixed z-50`) mora dentro de `.page-enter` (animação de opacity
 * com `both` = contexto de empilhamento), então o z-50 ficava preso abaixo do z-20 da tira e o `trigger` interceptava
 * o clique no X do modal (pego pelo `catalogo-terapeutico-humano` no CI).
 *
 * Regressão curta, pela borda real do navegador: staff com MAIS de uma área navegável abre o modal do catálogo
 * terapêutico e clica no X com click real (o Playwright recusa o clique se outro elemento o intercepta).
 * Só `GET /v1/me/areas` é substituído (o stack de CI não tem uma pessoa com staff + prestador); o resto é o stack real.
 */
import { test, expect } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const STAMP = Date.now();
const STAFF: MockUser = { uid: `e2e-areasw-${STAMP}`, email: `e2e.areasw.${STAMP}@enlite.health`, role: 'admin', country: 'AR' };

test.use({ viewport: { width: 1600, height: 1000 } });

test.afterAll(() => {
  try { runSQL(`DELETE FROM users WHERE email = '${STAFF.email}'`); } catch { /* limpeza não esconde o resultado */ }
});

test('com > 1 área navegável, a tira do seletor aparece e NÃO intercepta o X do modal do catálogo @integration', async ({ page }) => {
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${STAFF.uid}', '${STAFF.email}', 'E2E AreaSw', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await loginComoStaffMock(page, STAFF, 'E2E AreaSw');
  await page.route('**/v1/me/areas', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        areas: [
          { area: 'backoffice', role: 'staff', entryRoute: '/admin' },
          { area: 'care', role: 'worker', entryRoute: '/' },
        ],
        tokenRefreshRequired: false,
      }),
    }),
  );

  await page.goto('/admin/catalogos/objetivos-especificos');
  await expect(page.getByTestId('area-switcher-trigger')).toBeVisible({ timeout: 30_000 }); // controle de não-vacuidade: a tira existe
  await expect(page.getByTestId('therapeutic-catalog-table')).toBeVisible();

  // O menu ABERTO tem de ficar acima do conteúdo (`trial`: checa que o clique alcançaria a opção, sem navegar).
  await page.getByTestId('area-switcher-trigger').click();
  await page.getByTestId('area-switcher-option-care').click({ trial: true });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('area-switcher-menu')).toHaveCount(0);

  await page.getByTestId('therapeutic-catalog-new-btn').click();
  await expect(page.getByTestId('therapeutic-catalog-form-modal')).toBeVisible();
  // Click real: falha com "intercepts pointer events" se a tira estiver acima do modal.
  await page.getByTestId('therapeutic-catalog-form-close').click({ timeout: 10_000 });
  await expect(page.getByTestId('therapeutic-catalog-form-modal')).toHaveCount(0);
});
