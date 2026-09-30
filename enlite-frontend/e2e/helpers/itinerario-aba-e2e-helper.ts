/**
 * itinerario-aba-e2e-helper.ts
 *
 * Helpers do e2e de TELA da aba "Itinerario" da ficha do paciente (Fase 12, change
 * cadeia-paciente-vacante-itinerario, P30 — DX-12.14). Só o que os irmãos ainda não têm: abrir a
 * aba pela barra (clique real no botão, 5ª de 6, D442) esperando o `GET …/itinerary`, e ler as
 * alocações que o DOM mostra num slot.
 *
 * Reusa sem copiar: `backendUrl()` (`lancamento-e2e-helper.ts:32`, mesmo fallback do CI dos
 * irmãos, lida DENTRO das funções — nunca no topo do módulo, o Playwright carrega todos os specs
 * antes do `--grep`); molde de navegação `openEncuadreTab` (`quadro-c-e2e-helper.ts:111-121`).
 * A aba é um `<button>` sem `role="tab"` (DX-12.3) — achada por `getByRole('button', { name })`.
 * Nenhum host/porta literal, nenhum `throw` no import, nenhum preenchimento programático de campo.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';

/** Rótulo es-AR da aba (i18n `admin.patients.detail.tabs.itinerary`) — os specs rodam em es-AR. */
export const ITINERARY_TAB_LABEL = 'Itinerario';

/** `true` para o `GET /api/admin/patients/<id>/itinerary` servido pela API do e2e (não pelo Vite). */
export function isItineraryGet(r: Response, patientId: string): boolean {
  return (
    r.request().method() === 'GET' &&
    r.url().startsWith(backendUrl()) &&
    new RegExp(`/api/admin/patients/${patientId}/itinerary(\\?|$)`).test(r.url())
  );
}

/**
 * Ficha do paciente → clique real na aba "Itinerario" (`patient-profile-tabs`) → espera o
 * `GET …/itinerary` 200 e a raiz da aba (`itinerario-aba`) visível. Devolve a resposta do GET
 * (o chamador pode ler o corpo na MESMA execução para comparar DOM × rota).
 */
export async function openItineraryTab(page: Page, patientId: string): Promise<Response> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  const detailLoaded = page
    .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
    .catch(() => null);
  await page.goto(`/admin/patients/${patientId}`);
  await detailLoaded;
  const tabs = page.getByTestId('patient-profile-tabs');
  await expect(tabs).toBeVisible({ timeout: 15_000 });
  const [itinerary] = await Promise.all([
    page.waitForResponse((r) => isItineraryGet(r, patientId) && r.status() === 200, { timeout: 20_000 }),
    tabs.getByRole('button', { name: ITINERARY_TAB_LABEL }).click(),
  ]);
  await expect(page.getByTestId('itinerario-aba')).toBeVisible({ timeout: 15_000 });
  return itinerary;
}

/** Os nomes de quem cobre o slot na tela (`itinerario-slot-prestador-<slotId>-<workerId>`). */
export function slotAllocationsInDom(page: Page, slotId: string): Locator {
  return page.locator(`[data-testid^="itinerario-slot-prestador-${slotId}-"]`);
}

/**
 * Quantos prestadores o DOM mostra no slot AGORA. `.count()` não faz retry: chamar só depois de
 * uma asserção que já assentou a tela (`toHaveCount`/`toBeVisible`/`waitForResponse`) — serve
 * para o marcador `[12.x]`, nunca como a asserção em si.
 */
export function countSlotAllocationsInDom(page: Page, slotId: string): Promise<number> {
  return slotAllocationsInDom(page, slotId).count();
}
