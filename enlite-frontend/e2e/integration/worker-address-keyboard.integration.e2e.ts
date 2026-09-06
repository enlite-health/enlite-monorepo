/**
 * worker-address-keyboard.integration.e2e.ts @integration
 *
 * Regressão do achado de 31/08: escolher o endereço pelo TECLADO não gravava.
 *
 * Medido em prod, A/B controlado — mesmo worker, mesmo fluxo, só o gesto mudou:
 *   • clique do mouse na sugestão  → PUT /api/workers/me/service-area sai ✅
 *   • ArrowDown + Enter            → 60s sem PUT nenhum ❌
 *
 * Causa: o listener de `place_changed` do GooglePlacesAutocomplete guardava em
 * `if (place && place.formatted_address)`. Quando o usuário confirma pelo teclado,
 * o Autocomplete do Google entrega um place SEM `formatted_address` (só o texto
 * digitado) — e o componente descartava a seleção sem avisar ninguém.
 *
 * Este teste NÃO usa o `google-maps-fake`: um fake responderia o que nós mesmos
 * programamos e nunca reproduziria o comportamento real do widget do Google. É o
 * mesmo princípio do e2e-prod — o oráculo tem de ser o sistema de verdade.
 *
 * Run: pnpm test:e2e:integration
 */

import { test, expect } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.describe('@integration Endereço — teclado grava igual ao mouse', () => {
  test.setTimeout(120_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  for (const gesto of ['teclado', 'mouse'] as const) {
    test(`escolher a sugestão pelo ${gesto} dispara o autosave do endereço`, async ({ page }) => {
      const w = insertEligibilityWorker({ occupation: 'AT', serviceArea: false });
      workers.push(w);
      await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);

      await page.goto('/worker/profile?tab=address', { waitUntil: 'networkidle', timeout: 30_000 });
      const input = page.locator('[data-testid="address-autocomplete-input"]');
      await expect(input).toBeVisible({ timeout: 20_000 });

      // A escuta começa ANTES de digitar: o Autocomplete pode disparar
      // `place_changed` ainda durante a datilografia.
      const saved = page.waitForResponse(
        (r) =>
          r.url().includes('/api/workers/me/service-area') && r.request().method() === 'PUT',
        { timeout: 60_000 },
      );

      await input.click();
      // `fill()` não serve: o widget do Google escuta digitação, não `value=`.
      await input.pressSequentially('Av. Corrientes 1234', { delay: 120 });
      const suggestion = page.locator('.pac-item').first();
      await expect(suggestion, 'Google devolveu sugestão').toBeVisible({ timeout: 30_000 });

      if (gesto === 'teclado') {
        await input.press('ArrowDown');
        await input.press('Enter');
      } else {
        // Coordenadas, não `locator.click()`: a lista do Google se desmonta no blur
        // e o elemento some entre a checagem de actionability e o mousedown.
        const box = await suggestion.boundingBox();
        expect(box, 'a sugestão tem caixa clicável').not.toBeNull();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      }

      const resp = await saved.catch(() => {
        throw new Error(
          `[${gesto}] a seleção do endereço NÃO disparou PUT /api/workers/me/service-area. ` +
            'O endereço se perde em silêncio — é o achado de 31/08.',
        );
      });
      expect(resp.status(), `[${gesto}] o autosave do endereço passa`).toBeLessThan(400);
    });
  }
});
