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
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Auth setup — cria worker via REST no Firebase Emulator e salva storageState
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },

    // Chromium — testes que precisam de worker auth usam test.use({ storageState }) no arquivo
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: '**/integration/**',
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
      testIgnore: '**/integration/**',
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
      testIgnore: '**/integration/**',
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
