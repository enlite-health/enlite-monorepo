/**
 * F4 (T409) — o seletor de área (tira dentro do <main> do AdminLayout) NÃO pode ficar por cima de modal.
 * Causa medida: a tira era `sticky z-20` e o modal (`fixed z-50`) mora dentro de `.page-enter` (animação de opacity
 * com `both` = contexto de empilhamento), então o z-50 ficava preso abaixo do z-20 da tira e o `trigger` interceptava
 * o clique no X do modal (pego pelo `catalogo-terapeutico-humano` no CI).
 *
 * Regressão curta, pela borda real do navegador: staff com MAIS de uma área navegável abre o modal do catálogo
 * terapêutico e clica no X com click real (o Playwright recusa o clique se outro elemento o intercepta).
 * Sem mock de DADO: a pessoa tem linha em `users` (staff) E ficha em `workers` (prestador) com o mesmo uid, e `GET /v1/me/areas`
 * vem da API real com banco real (`installAuthInterceptors` só troca o Authorization por `mock_*`; a resposta é a real).
 */
import { test, expect } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const STAFF: MockUser = { uid: `e2e-areasw-${STAMP}`, email: `e2e.areasw.${STAMP}@enlite.health`, role: 'recruiter', country: 'AR' };

test.use({ viewport: { width: 1600, height: 1000 } });

test.afterAll(() => {
  try { runSQL(`DELETE FROM workers WHERE auth_uid = '${STAFF.uid}'`); } catch { /* idem */ }
  try { runSQL(`DELETE FROM users WHERE email = '${STAFF.email}'`); } catch { /* limpeza não esconde o resultado */ }
});

test('com > 1 área navegável, a tira do seletor aparece e NÃO intercepta o X do modal do catálogo @integration', async ({ page }) => {
  // Mesma semente do `unified-login` (`linhaDeStaff` + `fichaDePrestador`): staff que também é prestador → 2 áreas navegáveis.
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
     VALUES ('${STAFF.uid}', '${STAFF.email}', 'E2E AreaSw', 'recruiter', 'ACTIVE', true, '${TENANT}')
     ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, status = 'ACTIVE', is_active = true`,
  );
  runSQL(`INSERT INTO workers (auth_uid, email, status, country) VALUES ('${STAFF.uid}', '${STAFF.email}', 'INCOMPLETE_REGISTER', 'AR')`);
  await loginComoStaffMock(page, STAFF, 'E2E AreaSw');
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
