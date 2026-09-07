/**
 * blocked-attempts-admin-only.e2e.ts
 *
 * FLOW-GUARD — prova do fluxo com AUTH FIREBASE REAL (enlite-prd) + backend
 * prod-auth + Postgres real. NENHUM page.route / mock no caminho.
 *
 * Fluxo provado:
 *   login real → sidebar (item da seção Administración) → BlockedAttemptsPage
 *   (guarda de container por `recruitment:read`) →
 *   GET /api/admin/recruitment/blocked-attempts → leitura de
 *   worker_blocked_applications.
 *
 * Perspectivas (a decisão é da CÉLULA, não de papel — o ABAC tirou `role` do
 * contrato; quem filia a conta a um grupo é o painel de Acessos):
 *   - COM `recruitment:read`: vê item, acessa tela, total renderizado CONFERE
 *     com count(*) no banco real.
 *   - SEM `recruitment:read`: não vê item nem seção; URL direta redireciona
 *     pra /admin.
 *
 * ⚠️ O gate de UI só aperta com `enforcement === 'on'` no contrato (D268). Com
 * o engine desligado a segunda perspectiva NÃO se sustenta — a tela abre pra
 * todo mundo, de propósito. Por isso o segundo teste checa o contrato antes e
 * pula quando o engine está off, em vez de reprovar por um cenário impossível.
 *
 * Pré-condições (skip automático se ausentes): backend prod-auth em :8080,
 * dev server em :5173, container enlite-postgres.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'Teste@123';
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
const SEM_CELULA_EMAIL = 'gabriel.g.stein+guardtest@gmail.com';

// UIDs reais no Firebase enlite-prd (contas de teste sancionadas do projeto)
const COM_CELULA_UID = 'DX8fmELP0ea3P3GbJav4k1yYRr62';
const SEM_CELULA_UID = 'OXyYjNPovBhrPATEebA7e4qMKn12';
const TENANT = '00000000-0000-0000-0000-000000000001';
const GRUPO_COM_CELULA = 'FlowGuard Recruitment Read';

let grupoId = '';

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

test.describe('Postulaciones bloqueadas por célula — fluxo real (flow-guard)', () => {
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
    // Email alias no primeiro pra não colidir com a linha dev-local-gabriel.
    // display_name é o marcador de propriedade: o cleanup só apaga linhas nossas.
    // `users.role` ainda é coluna do banco, mas não decide nada na UI — é
    // preenchimento, não regra de acesso.
    psql(
      `INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
       VALUES ('${COM_CELULA_UID}', 'gabriel.g.stein+flowguard@gmail.com', 'FlowGuard Admin', 'admin', NOW(), NOW()),
              ('${SEM_CELULA_UID}', '${SEM_CELULA_EMAIL}', 'FlowGuard Recruiter', 'recruiter', NOW(), NOW())
       ON CONFLICT (firebase_uid) DO NOTHING`,
    );

    // A conta que DEVE ver a tela ganha `recruitment:read` por um grupo próprio;
    // a outra fica sem grupo nenhum. É essa diferença — e só ela — que o spec mede.
    grupoId = psql(
      `INSERT INTO iam.permission_groups (tenant_id, name, description)
       VALUES ('${TENANT}', '${GRUPO_COM_CELULA}', 'flow-guard e2e — nao mexer manual')
       RETURNING id`,
    );
    const concedida = psql(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
       SELECT '${grupoId}', id FROM iam.permissions WHERE resource='recruitment' AND action='read'
       RETURNING permission_id`,
    );
    if (!concedida) throw new Error('célula recruitment:read não existe em iam.permissions');
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COM_CELULA_UID}', '${grupoId}', '${TENANT}')`);
  });

  test.afterAll(async ({ browserName }) => {
    if (browserName !== 'chromium') return;
    try {
      if (grupoId) {
        psql(`DELETE FROM iam.user_groups WHERE group_id='${grupoId}'`);
        psql(`DELETE FROM iam.group_permissions WHERE group_id='${grupoId}'`);
        psql(`DELETE FROM iam.permission_groups WHERE id='${grupoId}'`);
      }
      // Apaga apenas as linhas criadas por este spec (marcador display_name);
      // linha pré-existente com outro display_name é preservada.
      psql(
        `DELETE FROM users WHERE firebase_uid IN ('${COM_CELULA_UID}', '${SEM_CELULA_UID}')
         AND display_name IN ('FlowGuard Admin', 'FlowGuard Recruiter')`,
      );
    } catch {
      // cleanup best-effort
    }
  });

  test('COM recruitment:read: item na seção Administración → tela carrega dado real do banco', async ({ page }) => {
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

  test('SEM recruitment:read: sem item no menu e URL direta redireciona pra /admin', async ({ page }) => {
    // Com o engine desligado o gate não aperta (D268) — o cenário é impossível,
    // não falho: pulo e digo por quê, em vez de reprovar por régua desligada.
    const authz = await fetch('http://localhost:8080/v1/me/authz').catch(() => null);
    const enforcement = authz?.ok ? ((await authz.json()) as { enforcement?: string }).enforcement : undefined;
    test.skip(enforcement !== 'on', `engine ABAC não está ligado (enforcement=${enforcement ?? 'desconhecido'})`);

    await loginReal(page, SEM_CELULA_EMAIL);

    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByText('Usuarios')).toBeVisible({ timeout: 20000 });
    await expect(sidebar.getByText('Postulaciones bloqueadas')).toHaveCount(0);
    await expect(sidebar.getByText('Administración')).toHaveCount(0);

    await expect(sidebar).toHaveScreenshot('flowguard-sem-celula-sidebar.png', {
      maxDiffPixelRatio: 0.03,
    });

    // URL direta → guard redireciona sem renderizar a tela
    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page).toHaveURL(/\/admin$/, { timeout: 20000 });
    await expect(page.locator('[data-testid="blocked-content"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="blocked-skeleton"]')).toHaveCount(0);
  });
});
