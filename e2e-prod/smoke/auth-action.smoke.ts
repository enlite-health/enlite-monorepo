/**
 * Smoke — CAMINHO DE ERRO da rota de ação de auth: /auth/action.
 *
 * É a landing dos links de e-mail (reset de senha). Aqui provamos os dois estados de
 * erro AMIGÁVEIS que ela pinta quando o link é ruim — ambos 100% seguros e read-only:
 * o branch de erro é decidido SÓ pelos query params (AuthActionPage.useEffect), sem
 * tocar Firebase quando falta `oobCode`.
 *
 *   1) mode não suportado (`?mode=xxx`)         → "Acción no soportada"
 *      (useEffect: mode !== 'resetPassword' → error-verification; titleKey unsupportedMode)
 *   2) mode válido SEM oobCode (`?mode=resetPassword`) → "Este enlace es inválido o expiró"
 *      (useEffect: !oobCode → error-verification; titleKey linkInvalid — retorna ANTES de
 *       verifyPasswordResetCode, então nenhuma chamada de rede/Firebase acontece)
 *
 * NÃO duplica public-pages.smoke.ts: lá o caso é `/auth/action` SEM nenhum param (@depth:smoke,
 * render estável). Aqui são os dois caminhos de ERRO por param específico (@depth:error).
 *
 * Mensagens batidas contra es.json (auth.action.*) em 2026-07-11. Web-first absorve o
 * estado inicial 'verifying' (spinner) antes de resolver pro card de erro.
 */
import { test, expect } from '@playwright/test';

test('[@route:/auth/action @depth:error] mode não suportado mostra "Acción no soportada"', async ({ page }) => {
  await page.goto('/auth/action?mode=xxx');
  await expect(
    page.getByRole('heading', { name: 'Acción no soportada' }),
  ).toBeVisible();
});

test('[@route:/auth/action @depth:error] reset sem oobCode mostra enlace inválido/expirado', async ({ page }) => {
  // mode válido mas sem código → linkInvalid, sem tocar Firebase (retorna no !oobCode).
  await page.goto('/auth/action?mode=resetPassword');
  await expect(
    page.getByRole('heading', { name: 'Este enlace es inválido o expiró' }),
  ).toBeVisible();
});
