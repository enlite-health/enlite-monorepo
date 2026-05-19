/**
 * One-shot script para gerar o baseline visual de /admin/api-docs.
 *
 * Login REAL no Firebase Prod com credenciais via env vars (NÃO commita
 * credenciais — passa via shell na hora de rodar).
 *
 * Pré-condições:
 *   - frontend dev em http://localhost:5173 (pnpm dev)
 *   - credenciais staff/admin em FIREBASE_E2E_EMAIL e FIREBASE_E2E_PASSWORD
 *
 * Uso:
 *   FIREBASE_E2E_EMAIL=seu@email.com FIREBASE_E2E_PASSWORD=sua-senha \
 *     node scripts/capture-api-docs-snapshot.mjs
 *
 * Salva: e2e/admin-api-docs.e2e.ts-snapshots/admin-api-docs-home-chromium-darwin.png
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const EMAIL = process.env.FIREBASE_E2E_EMAIL;
const PASSWORD = process.env.FIREBASE_E2E_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('[snap] FIREBASE_E2E_EMAIL e FIREBASE_E2E_PASSWORD são obrigatórios');
  process.exit(1);
}

const MOCK_OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Enlite worker-functions API', version: '1.0.0' },
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
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/admin/patients': {
      get: {
        tags: ['Admin · Patients'],
        summary: 'Lista pacientes paginados',
        description: 'Retorna pacientes com filtros opcionais e total.',
        security: [{ firebaseAuth: [] }],
        responses: {
          200: { description: 'Lista de pacientes' },
          401: { description: 'Token inválido' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      firebaseAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
};

const OUTPUT = path.resolve(
  'e2e/admin-api-docs.e2e.ts-snapshots/admin-api-docs-home-chromium-darwin.png',
);

async function main() {
  console.log('[snap] launching chromium...');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // Mock spec — backend pode estar rodando ou não, não importa
  await page.route('**/api/docs/openapi.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_OPENAPI_SPEC),
    }),
  );

  // Mock profile — o backend local não tem o usuário gabriel na DB.
  // Retorna superadmin pra passar pelo check do AdminLoginPage.
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'snap-uid',
          email: EMAIL,
          role: 'superadmin',
          firstName: 'Snap',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  console.log('[snap] logging in via UI (real Firebase)...');
  await page.goto(`${FRONTEND}/admin/login`);

  console.log('[snap] login page URL:', page.url());
  await page.screenshot({ path: '/tmp/snap-debug-1-login-page.png' });

  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Espera SDK Firebase autenticar (pode levar alguns segundos)
  await page.waitForTimeout(5000);
  console.log('[snap] after submit URL:', page.url());
  await page.screenshot({ path: '/tmp/snap-debug-2-after-submit.png' });

  try {
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25_000 });
    console.log('[snap] logged in at', page.url());
  } catch (e) {
    console.error('[snap] redirect timeout. Current URL:', page.url());
    console.error('[snap] page content snippet:');
    console.error((await page.content()).slice(0, 2000));
    throw e;
  }

  console.log('[snap] navigating to /admin/api-docs...');
  await page.goto(`${FRONTEND}/admin/api-docs`);
  await page.waitForSelector('.swagger-ui .opblock-tag', { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);

  const dir = path.dirname(OUTPUT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  console.log('[snap] saving screenshot to', OUTPUT);
  await page.screenshot({ path: OUTPUT, fullPage: false, animations: 'disabled' });

  await browser.close();
  console.log('[snap] done.');
}

main().catch((err) => {
  console.error('[snap] failed:', err);
  process.exit(1);
});
