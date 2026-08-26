/**
 * admin-access.e2e.ts
 *
 * Playwright E2E — /admin/access (painel de acessos), as TRÊS posturas por célula:
 *   1. hidden: sem `permission_management:*` → sem item no menu, e a URL redireciona
 *   2. read:   item no menu; lista visível; "Nuevo grupo" NÃO existe; detalhe sem inputs
 *   3. write:  "Nuevo grupo" existe; detalhe com inputs e "Guardar"
 *
 * Auth: Firebase Emulator + profile API mock (padrão dos outros e2e). O contrato
 * `/v1/me/authz` e a API do painel são mockados via `page.route` — o que se prova
 * aqui é a TELA obedecendo ao contrato, não o backend (que tem e2e próprio).
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

const GRUPO = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 't', name: 'Recrutadores AR', description: 'Quem recruta na Argentina',
  isSystem: false, archivedAt: null, createdBy: 'u0', createdAt: '2026-08-01T00:00:00Z',
  cells: ['worker:read'], countries: ['AR'], memberCount: 0,
};

async function login(page: Page, permissions: string[]): Promise<void> {
  const email    = `e2e.access.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  await page.route('**/api/admin/auth/profile', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { id: uid, firebaseUid: uid, email, displayName: 'Access E2E', role: 'recruiter', department: null, lastLoginAt: null, loginCount: 1, createdAt: new Date().toISOString() } }),
  }));
  await page.route('**/v1/me/authz', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ uid, tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {} }),
  }));
  await page.route('**/api/admin/permission-groups', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [GRUPO] }),
  }));
  await page.route(`**/api/admin/permission-groups/${GRUPO.id}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(GRUPO),
  }));
  await page.route(`**/api/admin/permission-groups/${GRUPO.id}/members`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ members: [] }),
  }));
  await page.route('**/api/admin/permissions/catalog', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ categories: [{ category: 'workers', cells: [{ resource: 'worker', action: 'read', category: 'workers', ownerService: 'wf' }] }] }),
  }));
  await page.route('**/api/admin/users**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { admins: [], total: 0 } }),
  }));

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

test.describe('painel de acessos — regra por componente', () => {
  test('hidden: sem a célula, o item não existe e a URL redireciona', async ({ page }) => {
    await login(page, ['worker:read']);
    await expect(page.getByRole('link', { name: /Accesos|Acessos/ })).toHaveCount(0);
    await page.goto('/admin/access');
    await expect(page).not.toHaveURL(/\/admin\/access/);
  });

  test('read: lista visível, aviso de só leitura, sem "Nuevo grupo"; detalhe sem inputs', async ({ page }) => {
    await login(page, ['permission_management:read']);
    await page.getByRole('link', { name: /Accesos|Acessos/ }).click();
    await expect(page.getByText('Recrutadores AR')).toBeVisible();
    await expect(page.getByTestId('read-only-notice')).toBeVisible();
    await expect(page.getByRole('button', { name: /Nuevo grupo|Novo grupo/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Abrir/ }).click();
    await expect(page.getByTestId('g-name-readonly')).toBeVisible();
    await expect(page.locator('input#g-name')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Guardar|Salvar/ })).toHaveCount(0);
  });

  test('write: "Nuevo grupo" existe; detalhe com input e "Guardar"', async ({ page }) => {
    await login(page, ['permission_management:read', 'permission_management:write']);
    await page.goto('/admin/access');
    await expect(page.getByRole('button', { name: /Nuevo grupo|Novo grupo/ })).toBeVisible();
    await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
    await page.getByRole('button', { name: /Abrir/ }).click();
    await expect(page.locator('input#g-name')).toHaveValue('Recrutadores AR');
    await expect(page.getByRole('button', { name: /^(Guardar|Salvar)$/ })).toBeVisible();
  });
});
