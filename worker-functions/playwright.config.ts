/**
 * Playwright config para os testes de OpenAPI/Swagger UI.
 *
 * Estratégia:
 *   - O webServer NÃO é gerenciado pelo Playwright. Antes de rodar, suba
 *     o stack docker (`npm run test:playwright:docker` faz isso automaticamente).
 *   - O API_URL aponta para o container em http://localhost:8080.
 *   - OPENAPI_PUBLIC=true (já setado no docker-compose.test.yml via NODE_ENV=test)
 *     deixa /api/docs público — o teste não precisa de token Firebase.
 *
 * Para rodar local sem docker, defina API_URL ao seu server e garanta
 * OPENAPI_PUBLIC=true ou NODE_ENV != production.
 */

import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests/playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: API_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      // Pequena tolerância para anti-aliasing de fontes entre OS.
      maxDiffPixelRatio: 0.02,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
