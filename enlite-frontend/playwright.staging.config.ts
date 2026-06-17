/**
 * playwright.staging.config.ts
 *
 * Configuração dedicada para rodar o E2E de staging real.
 * Aponta o baseURL para o frontend de staging e desabilita o global-setup
 * que exige localhost:5173.
 *
 * Uso:
 *   BASE_URL=https://enlite-frontend-vtf37eainq-tl.a.run.app \
 *   STAGING_WORKER_EMAIL=e2e.staging.worker.1781705591@enlite.test \
 *   STAGING_WORKER_PASS=StagingWorker123! \
 *   pnpm exec playwright test e2e/staging-full-journey.e2e.ts \
 *     --config=playwright.staging.config.ts \
 *     --project=chromium-staging
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL =
  process.env.BASE_URL ?? 'https://enlite-frontend-vtf37eainq-tl.a.run.app';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/staging-full-journey.e2e.ts',

  // Sem globalSetup — staging não precisa verificar Docker local
  globalSetup: undefined,

  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: 'html',

  use: {
    baseURL: BASE_URL,
    trace: 'on',
    screenshot: 'on',
    // Timeouts maiores para cold start de Cloud Run
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium-staging',
      use: {
        ...devices['Desktop Chrome'],
        // Viewport padrão
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
