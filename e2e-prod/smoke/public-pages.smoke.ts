/**
 * Smoke — páginas públicas restantes renderizam estado ESTÁVEL (read-only).
 *
 * Prova que o SPA monta cada rota e pinta o estado esperado (sem tela branca/crash),
 * inclusive quando falta o parâmetro que a página exige — nesse caso o esperado é um
 * estado amigável (redirect ou erro), não um erro cru. Zero efeito colateral: só
 * navegação + asserção de render.
 *
 * Comportamentos confirmados no source (enlite-frontend):
 *  - CompleteWhatsappPage: guard `if (!isAuthenticated) navigate('/login')` — sem sessão
 *    (browser limpo) a rota redireciona pro login. Asseramos o pouso no /login.
 *  - AuthActionPage: sem `?mode=resetPassword` → estado 'error-verification' → ActionErrorCard
 *    com título `auth.action.unsupportedMode` = "Acción no soportada" (es.json). Estado estável.
 *
 * NOTA (achado real, 2026-07-11): a UI de "Vacante no encontrada" (/vacantes/<uuid inexistente>)
 * originalmente NÃO renderizava sob as condições do monitor por causa do header custom
 * `x-e2e-synthetic` que a suíte injetava: ele forçava preflight CORS e, como as respostas de
 * ERRO da API (404) não traziam cabeçalho CORS nesse cenário, o fetch cross-origin do browser
 * falhava com net::ERR_FAILED e o frontend caía no branch de erro genérico. Esse header foi
 * REMOVIDO (2026-07-11) justamente por isso. Mesmo assim, o check de 404 permanece no nível de
 * API (public-vacancy-api.smoke.ts cobre GET /api/vacancies/:id → 404), que é mais determinístico.
 * O render smoke de /vacantes/:id (caminho positivo) já é coberto por public-vacancy.smoke.ts.
 *
 * Front é i18n ES (es-AR). Textos batidos contra es.json em 2026-07-11.
 */
import { test, expect } from '@playwright/test';

test('[@route:/complete-whatsapp @depth:smoke] sem sessão redireciona pro login (estado estável)', async ({ page }) => {
  await page.goto('/complete-whatsapp');

  // Guard sem auth → /login. Provamos pelo formulário de login renderizado (web-first,
  // tolerante ao redirect + cold start). getByLabel via FormField(label) ↔ input#id.
  await expect(page.getByLabel('Correo electrónico', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('[@route:/auth/action @depth:smoke] sem parâmetros mostra erro amigável estável', async ({ page }) => {
  await page.goto('/auth/action');

  // mode ausente ≠ 'resetPassword' → ActionErrorCard "Acción no soportada" (heading nível 2).
  // Web-first absorve o estado inicial 'verifying' (spinner) antes de resolver pro erro.
  await expect(
    page.getByRole('heading', { name: 'Acción no soportada' }),
  ).toBeVisible();
});
