import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loader mínimo de .env.local (sem dependência de `dotenv`). 12-factor: variáveis JÁ
 * setadas no ambiente (Cloud Run Job / shell) SEMPRE vencem — só preenchemos o que falta.
 * Assim `npx playwright test` é auto-suficiente no dev (lê .env.local, gitignored) sem
 * exigir export manual, e em prod o Job injeta as vars reais e este arquivo nem existe.
 */
function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '.env.local');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // ambiente real vence
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvLocal();

/**
 * Synthetic monitoring — Playwright contra PRODUÇÃO real (enlite-prd).
 * Regras em CLAUDE.md. Pontos que este config materializa:
 *  - URLs vêm de ENV (12-factor) — nunca hardcode. Valores reais setados pelo
 *    Cloud Run Job / .env.local (ver .env.example, gerado após a recon confirmar as URLs).
 *  - Timeouts TOLERANTES a cold start do Cloud Run (serviço ocioso às 3h da manhã).
 *  - trace on-first-retry = "time-travel debugging" do run que falhou (Fowler/Checkly).
 *  - retries: 1 no smoke = warm-up (1 retry distingue blip de outage; só alerta em falha consecutiva).
 *  - PROIBIDO page.route()/mock nos projetos que SÃO o monitor (smoke/regression/admin):
 *    lá mockar destruiria a única coisa que eles provam — que produção responde. Erro de
 *    negócio se testa real; erro de infra se monitora. (Enforcement por lint virá em .claude/rules.)
 *    ÚNICA exceção, no projeto `unit`: os helpers de `src/support` que JULGAM pass/fail podem
 *    stubar `fetch`, porque o que precisa ser encenado ali é a falha do TERCEIRO (o 500 do
 *    Google), que não se encomenda em prod. Ver o bloco do projeto `unit` mais abaixo.
 */

const BASE_URL = process.env.PROD_BASE_URL; // ex.: https://<hash>.a.run.app (front prod) — recon confirma
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: '.',
  // Cada teste inteiro tolera cold start + jornada curta:
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: IS_CI,
  fullyParallel: true,
  // Sem retry infinito mascarando instabilidade real; 1 retry no smoke tratado por projeto.
  retries: 0,
  // CI (job diário) = 1 worker = SERIAL global. Obrigatório: o job roda TODOS os projetos
  // num único `playwright test`, e as jornadas de regression chamam o cleanup GLOBAL is_test
  // (`DELETE ... WHERE is_test=true`). Dois testes is_test concorrentes → o cleanup de um
  // apaga os dados do outro no meio (corrupção). Serial custa poucos minutos (~6min a suíte
  // toda) e o job tem 15min de timeout — segurança > velocidade num monitor. Local = teto de 2
  // (era `undefined`/auto por CPU — mesmo defeito medido no jest do worker-functions, 11/09).
  workers: IS_CI ? 1 : 2,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/results.xml' }],
    // Reporter custom: a cada run envia EMAIL (SendGrid, sender verificado do backend) com o
    // resultado + grava test-results/failures.json (input do agente de auto-cura e2e-repair).
    // DRY-RUN automático sem SENDGRID_API_KEY (ou MONITOR_EMAIL_DRYRUN=1) — não envia, só loga.
    ['./src/report/sendgridReporter.ts'],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // NB: não injetamos header custom (ex.: x-e2e-synthetic). O backend não o honra e
    // um header não-permitido dispara preflight CORS que faz respostas de erro (404)
    // falharem no browser antes do teste observar o status. Tráfego sintético é
    // identificado por outros meios (conta/marca), não por header.
  },
  projects: [
    // CAMADA 1 — smoke: read-only, diário 3h, só os fluxos MAIS críticos. O "monitor" de verdade.
    {
      name: 'smoke',
      testDir: './smoke',
      testMatch: /\.smoke\.ts$/, // specs deste projeto usam sufixo .smoke.ts (não .spec)
      retries: 1, // warm-up: 1 retry absorve cold start; alerta só em falha consecutiva
      use: { ...devices['Desktop Chrome'] },
    },
    // CAMADA 2 — regression: writes + teardown, semanal/sob-demanda. Cobertura total.
    // TODO(recon): dependência do setup de auth (auth.setup.ts) — pendente do mecanismo de login prod.
    //
    // SERIAL DE PROPÓSITO (fullyParallel:false + `test:regression` usa --workers=1):
    // são jornadas de ESCRITA reais contra prod. Rodá-las em paralelo é flaky — não por
    // bug de usuário, mas por concorrência de infra: cada escrita vai no primário e a
    // resolução seguinte (`resolveWorkerIdFromAuth`, save de doc, etc.) lê uma read-replica
    // atrasada → 404/400 intermitente em passos DIFERENTES a cada run (evidência: diário
    // 2026-07-14). Serial = 3/3 verde e determinístico, que é o ponto de um MONITOR. Um
    // usuário real single-threaded nunca vê isso; disparar N jornadas simultâneas, sim.
    {
      name: 'regression',
      testDir: './regression',
      testMatch: /\.regression\.ts$/, // specs deste projeto usam sufixo .regression.ts
      // A jornada do paciente precisa da sessão admin (ler o big number NA TELA e
      // marcar/purgar o registro sintético). O storageState é criado pelo admin-setup.
      dependencies: ['admin-setup'],
      fullyParallel: false, // ver bloco acima — jornada de escrita não paraleliza
      // retries: 1 = WARM-UP (mesma lógica do smoke). A jornada faz 1 navegação de UI
      // (PASSO 8 da Fatia 3, página pública da vaga); um cold-start do Cloud Run do
      // frontend pode estourar o navigationTimeout na PRIMEIRA tentativa. 1 retry
      // distingue blip de outage — o monitor só alerta em falha CONSECUTIVA, não no
      // cold-start. Evidência do transiente: diário 2026-07-14.
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    // SETUP DE AUTH ADMIN — loga real no /admin/login e salva .auth/admin.json (indexedDB).
    // É dependência do projeto `admin`; não é um "teste" do monitor, é pré-condição.
    {
      name: 'admin-setup',
      testMatch: /admin\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    // TELAS ADMIN (read-only) — render de cada página autenticada. Reusa a sessão do setup.
    // Só roda depois do admin-setup (dependencies) e injeta o storageState salvo.
    {
      name: 'admin',
      testDir: './admin',
      testMatch: /\.admin\.ts$/, // specs deste projeto usam sufixo .admin.ts (o setup é .setup.ts, ignorado)
      dependencies: ['admin-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/admin.json',
      },
    },
    // UNIT — os helpers de `src/support` que decidem se um teste passa ou falha.
    // Não tocam rede nem browser (stub de `fetch`), rodam em ~3s e entram no run
    // diário sozinhos. Existem porque a política de retry do cloudLogging tem duas
    // metades opostas — repetir no transitório, LANÇAR no resto — e a metade
    // "lançar" é a que, se regredir, vira verde falso silencioso num gate de
    // paciente, em vez de teste vermelho.
    {
      name: 'unit',
      testDir: './src/support',
      testMatch: /\.spec\.ts$/,
      use: {},
    },
    // GATE DE COBERTURA — meta-teste: toda rota user-facing do manifesto tem spec? Senão, falha.
    {
      name: 'coverage-gate',
      testDir: './src/coverage',
      testMatch: /\.spec\.ts$/, // coverage.spec.ts (gate de rotas) + monitor-completeness.spec.ts (guard do runner)
      use: {},
    },
  ],
});
