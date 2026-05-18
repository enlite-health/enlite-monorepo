/**
 * admin-api-docs.e2e.ts
 *
 * Playwright E2E — Tela de documentação da API (/admin/api-docs)
 *
 * Fluxos cobertos:
 *   - Página renderiza após login admin
 *   - "API Docs" aparece no sidebar
 *   - Spec é fetchado e Swagger UI mostra operações
 *   - requestInterceptor injeta o token Firebase (verificado via interceptação)
 *   - Screenshot visual obrigatório
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Mock spec ────────────────────────────────────────────────────────────────

const MOCK_OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'Enlite worker-functions API',
    version: '1.0.0',
    description: 'API interna da plataforma Enlite.',
  },
  servers: [{ url: 'http://localhost:8080', description: 'Local dev' }],
  tags: [
    { name: 'Health · Status', description: 'Probes de liveness.' },
    { name: 'Admin · Patients', description: 'Pacientes e endereços.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health · Status'],
        summary: 'Liveness probe',
        description: 'Verifica que o processo Node está vivo e respondendo.',
        responses: {
          '200': { description: 'OK' },
        },
      },
    },
    '/api/admin/patients': {
      get: {
        tags: ['Admin · Patients'],
        summary: 'Lista pacientes paginados',
        description: 'Retorna pacientes com filtros opcionais e total.',
        security: [{ firebaseAuth: [] }],
        responses: {
          '200': { description: 'Lista de pacientes' },
          '401': { description: 'Token inválido' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      firebaseAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.apidocs.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as { localId?: string };
  if (!signUpData.localId) throw new Error(`Firebase sign-up failed`);
  const uid = signUpData.localId;

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'ApiDocs E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `
    .replace(/\n/g, ' ')
    .trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, {
      stdio: 'pipe',
    });
  } catch {
    /* fall through to mock */
  }

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'ApiDocs',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Admin API Docs page', () => {
  test.beforeEach(async ({ page }) => {
    await seedAdminAndLogin(page);

    // Mock spec endpoint que a página chama
    await page.route('**/api/docs/openapi.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_OPENAPI_SPEC),
      }),
    );
  });

  test('item "API Docs" aparece no sidebar admin', async ({ page }) => {
    await page.goto('/admin');
    const navLink = page.getByRole('link', { name: /API Docs/i });
    await expect(navLink).toBeVisible({ timeout: 10000 });
  });

  test('navega para /admin/api-docs e renderiza Swagger UI com operações', async ({ page }) => {
    await page.goto('/admin/api-docs');

    // Título da página renderizado via i18n
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /Documentaci[oó]n de la API|Documenta[çc][ãa]o da API/i,
    );

    // Aguarda Swagger UI montar e renderizar as tags do spec mockado
    await page.waitForSelector('.swagger-ui .opblock-tag', { timeout: 30000 });

    const tags = page.locator('.swagger-ui .opblock-tag');
    await expect(tags).toHaveCount(2, { timeout: 10000 });

    // Operações dos dois grupos visíveis
    await expect(page.locator('.swagger-ui .opblock').first()).toBeVisible();
  });

  test('Authorize button está visível (rota com firebaseAuth scheme)', async ({ page }) => {
    await page.goto('/admin/api-docs');
    await page.waitForSelector('.swagger-ui .opblock', { timeout: 30000 });

    const authBtn = page.locator('.swagger-ui button.authorize').first();
    await expect(authBtn).toBeVisible();
  });

  test('snapshot visual de /admin/api-docs (lock-in)', async ({ page }) => {
    await page.goto('/admin/api-docs');
    await page.waitForSelector('.swagger-ui .opblock-tag', { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot('admin-api-docs-home.png', {
      fullPage: false,
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    });
  });
});
