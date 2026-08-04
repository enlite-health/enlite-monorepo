import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: process.env.PW_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Auth setup — signIn REAL no Firebase (enlite-prd) via UI e salva storageState (emulator é proibido no projeto)
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },

    // Chromium — testes que precisam de worker auth usam test.use({ storageState }) no arquivo
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: ['**/integration/**', '**/vacancy-detail-localized-edit.e2e.ts', '**/kanban-card-notes-button.e2e.ts', '**/kanban-card-blocked-notes-button.e2e.ts', '**/vacancy-enum-i18n-real.e2e.ts'],
    },

    // Chromium-admin — testes admin que fazem login manual (não usam o storageState do worker)
    {
      name: 'chromium-admin',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/vacancy-detail-localized-edit.e2e.ts', '**/kanban-card-notes-button.e2e.ts', '**/kanban-card-blocked-notes-button.e2e.ts', '**/vacancy-enum-i18n-real.e2e.ts', '**/kanban-column-collapse.e2e.ts', '**/worker-detail-blocked-encuadre.e2e.ts', '**/prestadores-localidad-filter-visual.e2e.ts', '**/match-modal-select-and-totals.e2e.ts', '**/management-dashboard-visual.e2e.ts', '**/management-dashboard-por-prestador.e2e.ts', '**/management-dashboard-ayuda.e2e.ts', '**/kanban-role-modal.e2e.ts', '**/kanban-schedule-modal.e2e.ts'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
      testIgnore: ['**/integration/**', '**/vacancy-enum-i18n-real.e2e.ts'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
      testIgnore: ['**/integration/**', '**/vacancy-enum-i18n-real.e2e.ts'],
    },

    // Integration — full-stack tests (real backend + real DB). No Firebase Emulator needed.
    // Auth is handled internally via mock_* tokens (USE_MOCK_AUTH=true on Docker backend).
    {
      name: 'integration',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/integration/**/*.integration.e2e.ts',
    },
  ],
});
