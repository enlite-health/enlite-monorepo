import { test as setup, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WORKER_AUTH_FILE = path.join(__dirname, '.auth', 'profile-worker.json');

/**
 * E2E auth setup — Firebase REAL (enlite-prd). Emulator é proibido no projeto.
 * Loga via UI com a conta autorizada do owner do repo e salva storageState
 * (cookies + localStorage com Firebase token) pra reuso pelos testes chromium.
 *
 * Conta autorizada: gabriel.g.stein@gmail.com (override via env).
 */
const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'Teste@123';

setup('signin Firebase real e salva storageState', async ({ page }) => {
  await page.goto('/login');

  // Form usa InputWithIcon (não <label>), então usamos placeholder + selector estável.
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);

  // Botão "Iniciar sesión" (i18n es-AR)
  await page.getByRole('button', { name: /iniciar sesi[oó]n|entrar/i }).first().click();

  // Firebase real costuma demorar ~3-5s; damos 30s pra cobrir cold start.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

  // Em produção o Firebase usa IndexedDB (não localStorage). A escrita da sessão
  // é assíncrona após o redirect — esperamos a home renderizar e damos uma folga
  // pro Firebase persistir antes de capturar o estado.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_000);

  // Garante diretório .auth
  const authDir = path.dirname(WORKER_AUTH_FILE);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // indexedDB: true é essencial — sem isso o storageState sai vazio (a sessão do
  // Firebase vive no IndexedDB em prod) e os testes caem no /login. Requer
  // Playwright >= 1.51.
  await page.context().storageState({ path: WORKER_AUTH_FILE, indexedDB: true });
});
