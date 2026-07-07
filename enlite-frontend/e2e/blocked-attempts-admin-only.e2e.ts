/**
 * blocked-attempts-admin-only.e2e.ts
 *
 * FLOW-GUARD — prova do fluxo com AUTH FIREBASE REAL (enlite-prd) + backend
 * prod-auth + Postgres real. NENHUM page.route / mock no caminho.
 *
 * Fluxo provado:
 *   login real → sidebar (item admin-only na seção Administración) →
 *   BlockedAttemptsPage (guard de role) → GET /api/admin/recruitment/blocked-attempts
 *   (requireAdmin) → leitura de worker_blocked_applications.
 *
 * Perspectivas:
 *   - ADMIN (gabriel.g.stein@gmail.com, users.role=admin): vê item, acessa tela,
 *     total renderizado CONFERE com count(*) no banco real.
 *   - RECRUITER (alias +guardtest, users.role=recruiter, sem custom claim):
 *     não vê item nem seção; URL direta redireciona pra /admin.
 *
 * Pré-condições (skip automático se ausentes): backend prod-auth em :8080,
 * dev server em :5173, container enlite-postgres.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'Teste@123';
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
const RECRUITER_EMAIL = 'gabriel.g.stein+guardtest@gmail.com';

// UIDs reais no Firebase enlite-prd (contas de teste sancionadas do projeto)
const ADMIN_UID = 'DX8fmELP0ea3P3GbJav4k1yYRr62';
const RECRUITER_UID = 'OXyYjNPovBhrPATEebA7e4qMKn12';

function psql(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql}"`,
    { stdio: 'pipe' },
  )
    .toString()
    .trim();
}

async function backendIsProdAuth(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:8080/health');
    return res.ok;
  } catch {
    return false;
  }
}

async function loginReal(page: Page, email: string): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30000 });
}

test.describe('Postulaciones bloqueadas admin-only — fluxo real (flow-guard)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'flow-guard real-auth roda só em chromium');
  });

  test.beforeAll(async ({ browserName }) => {
    // firefox/webkit pulam os testes no beforeEach, mas os hooks rodariam mesmo
    // assim em paralelo e disputariam as mesmas linhas de users — sair cedo.
    if (browserName !== 'chromium') return;
    test.skip(!(await backendIsProdAuth()), 'backend prod-auth :8080 indisponível');

    // Staff rows pros uids reais (lookup do profile é por firebase_uid).
    // Email alias no admin pra não colidir com a linha dev-local-gabriel.
    // display_name é o marcador de propriedade: o cleanup só apaga linhas nossas.
    psql(
      `INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
       VALUES ('${ADMIN_UID}', 'gabriel.g.stein+flowguard@gmail.com', 'FlowGuard Admin', 'admin', NOW(), NOW()),
              ('${RECRUITER_UID}', '${RECRUITER_EMAIL}', 'FlowGuard Recruiter', 'recruiter', NOW(), NOW())
       ON CONFLICT (firebase_uid) DO UPDATE SET role = EXCLUDED.role`,
    );
  });

  test.afterAll(async ({ browserName }) => {
    if (browserName !== 'chromium') return;
    try {
      // Apaga apenas as linhas criadas por este spec (marcador display_name);
      // linha pré-existente com outro display_name é preservada.
      psql(
        `DELETE FROM users WHERE firebase_uid IN ('${ADMIN_UID}', '${RECRUITER_UID}')
         AND display_name IN ('FlowGuard Admin', 'FlowGuard Recruiter')`,
      );
    } catch {
      // cleanup best-effort
    }
  });

  test('ADMIN real: item na seção Administración → tela carrega dado real do banco', async ({ page }) => {
    await loginReal(page, ADMIN_EMAIL);

    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByText('Administración')).toBeVisible({ timeout: 20000 });
    await expect(sidebar.getByText('Postulaciones bloqueadas')).toBeVisible({ timeout: 10000 });

    // Prova visual do menu (área estável, sem dado dinâmico)
    await expect(sidebar).toHaveScreenshot('flowguard-admin-sidebar.png', {
      maxDiffPixelRatio: 0.03,
    });

    // Navega pelo próprio item e espera a resposta REAL da API (sem mock)
    const [apiResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/recruitment/blocked-attempts') && r.status() === 200,
        { timeout: 30000 },
      ),
      sidebar.getByText('Postulaciones bloqueadas').click(),
    ]);
    await expect(page).toHaveURL(/blocked-attempts/, { timeout: 10000 });

    // Total renderizado confere com o banco real
    const body = (await apiResponse.json()) as { aggregates: { totalBlocked: number } };
    const dbCount = Number(psql('SELECT count(*) FROM worker_blocked_applications'));
    expect(body.aggregates.totalBlocked).toBe(dbCount);

    const totalCard = page.locator('[data-testid="agg-total"], [data-testid="blocked-content"]').first();
    await expect(totalCard).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(String(dbCount)).first()).toBeVisible({ timeout: 10000 });
  });

  test('RECRUITER real: sem item no menu e URL direta redireciona pra /admin', async ({ page }) => {
    await loginReal(page, RECRUITER_EMAIL);

    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByText('Usuarios')).toBeVisible({ timeout: 20000 });
    await expect(sidebar.getByText('Postulaciones bloqueadas')).toHaveCount(0);
    await expect(sidebar.getByText('Administración')).toHaveCount(0);

    await expect(sidebar).toHaveScreenshot('flowguard-recruiter-sidebar.png', {
      maxDiffPixelRatio: 0.03,
    });

    // URL direta → guard redireciona sem renderizar a tela
    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page).toHaveURL(/\/admin$/, { timeout: 20000 });
    await expect(page.locator('[data-testid="blocked-content"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="blocked-skeleton"]')).toHaveCount(0);
  });
});
