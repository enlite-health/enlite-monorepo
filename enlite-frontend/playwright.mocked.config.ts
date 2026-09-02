/**
 * Playwright config for fully-mocked E2E tests.
 * Does NOT require the backend API (:8080) to be running.
 * All API calls are intercepted via page.route() inside each test.
 *
 * 🔒 A PORTA VEM DE `E2E_BASE_URL`, e o motivo é um defeito medido, não gosto.
 *
 * Ela era fixa em 5173. Este repositório trabalha em várias worktrees ao mesmo
 * tempo, e a primeira que sobe o `vite` fica com a porta. As outras não falham:
 * elas CONECTAM — no servidor da worktree vizinha — e fotografam o código de
 * OUTRA branch. O teste passa ou falha por um motivo que não tem nada a ver com
 * o diff em revisão, e o screenshot é a prova de uma tela que ninguém alterou.
 *
 * Medido em 01/09/2026: 5173 estava servindo `/private/tmp/fix-select-autosave`
 * (a branch do PR #276) enquanto a spec 010 era verificada noutra worktree.
 *
 *   vite --port 5199 &
 *   E2E_BASE_URL=http://localhost:5199 npx playwright test --config=playwright.mocked.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  /**
   * 🔒 OS TRÊS QUE TOCAM AMBIENTE REAL FICAM DE FORA — e a lista existe porque
   * o `testMatch` acima casa TODO arquivo de e2e, sem exclusão nenhuma. Um
   * `npx playwright test --config=playwright.mocked.config.ts` sem argumentos,
   * num config cujo nome é "mocked", disparava:
   *
   *   · `staging-journey-clean`  — sobe contra a stage E **cria e apaga usuário**
   *     no Firebase real (`identitytoolkit.googleapis.com`, accounts:signUp e
   *     accounts:delete);
   *   · `staging-full-journey`   — idem;
   *   · `vacancy-enum-i18n-real` — **signIn real no Firebase de produção** com a
   *     conta de teste, contra o backend real (`@real-auth`).
   *
   * A regra do projeto é "teste nunca toca canal real", e ela não pode depender
   * de quem roda lembrar de passar o caminho certo. Rodar esses três é ato
   * deliberado: aponte o arquivo, com as variáveis de ambiente que eles exigem.
   */
  testIgnore: [
    '**/staging-journey-clean.e2e.ts',
    '**/staging-full-journey.e2e.ts',
    '**/vacancy-enum-i18n-real.e2e.ts',
  ],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['line'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
