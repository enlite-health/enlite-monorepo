/**
 * admin-users.e2e.ts
 *
 * Playwright E2E — /admin/users (Admin Users management)
 *
 * Cenários cobertos:
 *   1. Listagem: tabela visível com Nombre/Email/Último login — SEM coluna de papel
 *      (o papel deixou de ser atributo do admin: quem pode o quê é a célula)
 *   2. Criar usuário: modal abre (só e-mail + nome), cria → fallback modal com link
 *   3. Gating por célula: com `enforcement: 'on'` e SEM `user_management:*`,
 *      Crear/Reset/Eliminar somem do DOM
 *   4. Gating por célula: com as células concedidas, os três aparecem
 *   5. Reset password: clica em Reset → InvitationFallbackModal abre com link
 *
 * Auth: Firebase Emulator + profile API mock (mesmo padrão dos outros testes E2E).
 * O contrato `/v1/me/authz` é mockado via `page.route`, como em `admin-access.e2e.ts`:
 * o que se prova aqui é a TELA obedecendo ao contrato, não o backend.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

/** Todas as células que a tela consome hoje. */
const CELULAS_USUARIOS = ['user_management:read', 'user_management:write', 'user_management:delete'];

// ── Mock data ──────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  firebaseUid: 'uid-admin-001',
  email: 'admin@enlite.health',
  displayName: 'Admin E2E',
  department: null,
  lastLoginAt: '2026-04-01T10:00:00Z',
  loginCount: 5,
  createdAt: '2026-01-01T00:00:00Z',
};

const MOCK_RECRUITER_USER = {
  firebaseUid: 'uid-recruiter-001',
  email: 'recruiter@enlite.health',
  displayName: 'Recruiter E2E',
  department: null,
  lastLoginAt: null,
  loginCount: 0,
  createdAt: '2026-02-01T00:00:00Z',
};

function usersListBody(users = [MOCK_ADMIN_USER, MOCK_RECRUITER_USER]) {
  return JSON.stringify({ success: true, data: users });
}

// ── Auth helper ────────────────────────────────────────────────────────────

/**
 * `permissions === null` = contrato ausente: o engine fica desligado e a tela
 * aparece como sempre apareceu (régua de rollout D268). Um array liga o
 * `enforcement: 'on'` e a célula passa a ser o único freio.
 */
async function seedAdminAndLogin(page: Page, permissions: string[] | null = null): Promise<void> {
  const email    = `e2e.users.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  // 1. Create Firebase Emulator user
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  // 2. Seed Postgres (best-effort — profile mock is the safety net). `role` fica no INSERT:
  //    a coluna é NOT NULL e ainda marca staff × prestador; só deixou de ser nível de acesso.
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Admin E2E', 'admin', NOW(), NOW())
      ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, {
      stdio: 'pipe',
    });
  } catch { /* ignore — profile mock covers this */ }

  // 3. Mock profile endpoint — o perfil não carrega mais papel.
  await page.route('**/api/admin/auth/profile', async (route) => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          firebaseUid: uid,
          email,
          displayName:       'Admin E2E',
          department:        'Tech',
          lastLoginAt:       new Date().toISOString(),
          loginCount:        1,
          createdAt:         new Date().toISOString(),
        },
      }),
    });
  });

  // 4. Contrato ABAC — só quando o teste quer o engine ligado.
  if (permissions !== null) {
    await page.route('**/v1/me/authz', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        uid, tenantId: 't', status: 'ACTIVE', permissions,
        countries: ['AR'], groups: [], features: {}, enforcement: 'on',
      }),
    }));
  }

  // 5. Login
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Mock users API ─────────────────────────────────────────────────────────

async function mockUsersApi(page: Page, users = [MOCK_ADMIN_USER, MOCK_RECRUITER_USER]) {
  await page.route('**/api/admin/users**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        usersListBody(users),
      });
    } else {
      await route.continue();
    }
  });
}

async function navigateToUsers(page: Page) {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: /Usuarios|Usuários/i })).toBeVisible({
    timeout: 10_000,
  });
}

// ── Cenário 1 — Listagem ───────────────────────────────────────────────────

test.describe('Admin Users — Cenário 1: Listagem', () => {
  test('tabela aparece com Último login e SEM coluna de papel', async ({ page }) => {
    await mockUsersApi(page);
    await seedAdminAndLogin(page);
    await navigateToUsers(page);

    // Coluna obrigatória
    await expect(page.getByRole('columnheader', { name: /login/i })).toBeVisible();
    // A coluna de papel saiu com o ABAC — e o <select> inline junto.
    await expect(page.getByRole('columnheader', { name: /^(Rol|Papel)$/i })).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0);

    // Linhas com dados mockados
    await expect(page.getByText('Admin E2E')).toBeVisible();
    await expect(page.getByText('Recruiter E2E')).toBeVisible();

    // Screenshot visual assertion
    await expect(page).toHaveScreenshot('admin-users-list.png', { maxDiffPixelRatio: 0.05 });
  });
});

// ── Cenário 2 — Criar usuário ──────────────────────────────────────────────

test.describe('Admin Users — Cenário 2: Criar usuário', () => {
  test('abre modal, preenche, cria → modal de fallback com link aparece', async ({ page }) => {
    const createdUser = {
      ...MOCK_RECRUITER_USER,
      firebaseUid: 'uid-new-001',
      email:       'new.recruiter@enlite.health',
      displayName: 'New Recruiter',
      resetLink:   'https://enlite.health/reset?oobCode=test-code-123',
    };

    await mockUsersApi(page);

    // Mock POST /api/admin/users
    await page.route('**/api/admin/users', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status:      200,
          contentType: 'application/json',
          body:        JSON.stringify({ success: true, data: createdUser }),
        });
      } else {
        await route.continue();
      }
    });

    await seedAdminAndLogin(page);
    await navigateToUsers(page);

    // Abrir modal
    await page.getByRole('button', { name: /Nuevo Usuario|Novo Usuário/i }).click();
    await expect(page.getByRole('heading', { name: /Nuevo Usuario|Novo Usuário/i })).toBeVisible();

    // Preencher campos — o convite não pede papel nenhum.
    await page.getByLabel(/Email/i).fill('new.recruiter@enlite.health');
    await page.getByLabel(/Nombre|Nome/i).fill('New Recruiter');
    await expect(page.locator('.fixed.inset-0').getByRole('combobox')).toHaveCount(0);

    // Screenshot do modal preenchido
    await expect(page.locator('.fixed.inset-0')).toHaveScreenshot('admin-users-create-modal.png', {
      maxDiffPixelRatio: 0.05,
    });

    // Submeter
    await page.getByRole('button', { name: /Crear|Criar/i }).click();

    // Fallback modal deve aparecer com link
    await expect(
      page.getByRole('heading', { name: /Usuario creado|Usuário criado/i }),
    ).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('https://enlite.health/reset?oobCode=test-code-123')).toBeVisible();

    // Screenshot do modal de fallback
    await expect(page.locator('.fixed.inset-0')).toHaveScreenshot('admin-users-invitation-fallback.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});

// ── Cenário 3 — Gating por CÉLULA, engine ligado ───────────────────────────

test.describe('Admin Users — Cenário 3: sem célula, sem botão', () => {
  test('enforcement "on" e nenhuma célula de user_management: Crear/Reset/Eliminar somem', async ({ page }) => {
    await mockUsersApi(page);
    await seedAdminAndLogin(page, []);
    await navigateToUsers(page);

    await expect(page.getByText('Admin E2E')).toBeVisible();

    // "Esconder, não desabilitar" (D269): os três saem do DOM.
    await expect(page.getByRole('button', { name: /Nuevo Usuario|Novo Usuário/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Reset$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Eliminar|Excluir/i })).toHaveCount(0);

    // Screenshot do gating
    await expect(page).toHaveScreenshot('admin-users-sem-celula.png', { maxDiffPixelRatio: 0.05 });
  });
});

// ── Cenário 4 — Com as células, os botões voltam ───────────────────────────

test.describe('Admin Users — Cenário 4: com as células, os botões existem', () => {
  test('enforcement "on" com user_management:write/delete: Crear/Reset/Eliminar aparecem', async ({ page }) => {
    await mockUsersApi(page);
    await seedAdminAndLogin(page, CELULAS_USUARIOS);
    await navigateToUsers(page);

    await expect(page.getByText('Admin E2E')).toBeVisible();

    await expect(page.getByRole('button', { name: /Nuevo Usuario|Novo Usuário/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reset$/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Eliminar|Excluir/i }).first()).toBeVisible();

    await expect(page).toHaveScreenshot('admin-users-com-celula.png', { maxDiffPixelRatio: 0.05 });
  });
});

// ── Cenário 5 — Reset password ────────────────────────────────────────────

test.describe('Admin Users — Cenário 5: Reset password', () => {
  test('clica em Reset → InvitationFallbackModal abre com link de restablecimento', async ({ page }) => {
    const resetLink = 'https://enlite.health/reset?oobCode=reset-code-e2e';

    await mockUsersApi(page);

    // Mock POST /api/admin/users/:id/reset-password
    await page.route('**/api/admin/users/*/reset-password', async (route) => {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          success: true,
          data: { resetLink, message: 'Email enviado' },
        }),
      });
    });

    await seedAdminAndLogin(page);
    await navigateToUsers(page);

    await expect(page.getByText('Admin E2E')).toBeVisible();

    // Clicar em "Reset" do primeiro usuário
    const resetButtons = page.getByRole('button', { name: /^Reset$/i });
    await resetButtons.first().click();

    // InvitationFallbackModal deve aparecer com título de reset
    await expect(
      page.getByRole('heading', { name: /restablecimiento|redefinição/i }),
    ).toBeVisible({ timeout: 8_000 });

    // O link de reset deve estar visível
    await expect(page.getByText(resetLink)).toBeVisible();

    // Screenshot do modal de fallback no modo reset
    await expect(page.locator('.fixed.inset-0')).toHaveScreenshot('admin-users-reset-password-fallback.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
