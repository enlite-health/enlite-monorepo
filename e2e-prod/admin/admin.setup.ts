/**
 * admin.setup.ts — LOGIN ADMIN REAL contra produção (enlite-prd), via UI.
 *
 * Espelha o padrão do enlite-frontend/e2e/auth.setup.ts, mas aponta pra PROD e usa a
 * conta de teste de admin (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, em .env.local — gitignored).
 *
 * Por que login REAL e não token forjado: a suíte é monitor de prod (zero mock). O único
 * jeito honesto de provar que a sessão admin funciona é logar como pessoa: digitar as
 * credenciais no /admin/login, submeter, e chegar em /admin. O storageState resultante é
 * reusado pelos specs do projeto `admin` (dependency: ['admin-setup']).
 *
 * indexedDB: true é ESSENCIAL — em produção o Firebase Auth persiste a sessão no IndexedDB
 * (não no localStorage). Sem essa flag o storageState sai vazio e os specs caem no /admin/login.
 * Requer Playwright >= 1.51.
 *
 * NOTA sobre promoção: o login Firebase funciona assim que a conta existe, MAS o AdminLoginPage
 * só redireciona pra /admin se o backend devolver um `adminProfile` (conta promovida a
 * staff/admin). Enquanto a conta não for promovida, o login autentica mas a página mostra
 * "Acceso negado" e NÃO navega — este setup vai falhar no `waitForURL('/admin')`. Esperado
 * até o user promover a conta. Depois disso, roda verde sem mudança de código.
 */
import { test as setup, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

setup('login admin real (Firebase prd) e salva storageState', async ({ page }) => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      '[admin.setup] E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD ausentes. ' +
        'Defina em .env.local (gitignored) ou no ambiente do Cloud Run Job.',
    );
  }

  // SEGURANÇA (fail-safe global): qualquer falha entre o fill da senha e o fim do setup
  // dispara captura de aria-snapshot (error-context.md) do Playwright, que expõe o VALUE
  // do input de senha em texto plano. O try/finally garante que a senha é ZERADA do DOM
  // antes de QUALQUER propagação de erro/screenshot — não só no caminho "não chegou em /admin".
  try {
    await page.goto('/admin/login');

    // AdminLoginPage usa FormField(label) + InputWithIcon/PasswordInput (ids admin-email/admin-password).
    // Selecionamos por tipo (estável e i18n-agnóstico) pra não depender de placeholder traduzido.
    await page.locator('input#admin-email').fill(ADMIN_EMAIL);
    await page.locator('input#admin-password').fill(ADMIN_PASSWORD);

    // Botão de submit "Iniciar sesión" (i18n es-AR).
    await page.getByRole('button', { name: /iniciar sesi[oó]n/i }).click();

    // Firebase real + cold-start Cloud Run: damos 30s. Sucesso = pousar em /admin (não /admin/login).
    // Se a conta ainda não foi promovida, a página exibe "Acceso negado" e NÃO navega.
    const reached = await page
      .waitForURL(
        (url) => /\/admin(\/|$)/.test(url.pathname) && !/\/admin\/login/.test(url.pathname),
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!reached) {
      throw new Error(
        '[admin.setup] Login autenticou no Firebase mas NÃO chegou em /admin — a conta ' +
          'de teste provavelmente não está promovida a staff/admin (a página mostra ' +
          '"Acceso negado"). Promova a conta e re-rode este setup.',
      );
    }

    // A escrita da sessão no IndexedDB é assíncrona após o redirect — deixamos a rede assentar.
    await page.waitForLoadState('networkidle').catch(() => {});

    const authDir = path.dirname(ADMIN_AUTH_FILE);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    await page.context().storageState({ path: ADMIN_AUTH_FILE, indexedDB: true });
  } finally {
    // Zera os campos SEMPRE (sucesso ou falha) antes que Playwright capture qualquer artefato.
    await page.locator('input#admin-password').fill('').catch(() => {});
    await page.locator('input#admin-email').fill('').catch(() => {});
  }
});
