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

/**
 * Digita uma data num `<input type="date">` como um humano e lê o valor de volta da TELA. Os segmentos do Chromium seguem o idioma
 * da UI do navegador (en-US → MMDDYYYY), NÃO o `locale` do contexto: digitar `ddmmaaaa` dava `102026-02-07` no CI (#712).
 */
export async function digitarDataNoCampo(page: Page, testId: string, iso: string): Promise<void> {
  const [y, m, d] = iso.split('-');
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(`${m}${d}${y}`);
  await expect(campo).toHaveValue(iso);
}

// ── Navegação da aba por serviço (spec 069, F7): lista (B1) → tela do serviço (B2) → sub-abas ─────────────────────────────

/**
 * Chega na TELA do serviço (B2) pela aba já aberta (`openItineraryTab`): com 1 serviço a aba já abre nela (a lista é pulada); com
 * 2+, clica "Organizar agenda" do cartão do serviço (e antes volta à lista se outro serviço estiver aberto). Cliques reais.
 */
export async function openServiceScreen(page: Page, serviceId: string): Promise<void> {
  const target = page.getByTestId(`itinerario-servico-tela-${serviceId}`);
  const anyScreen = page.locator('[data-testid^="itinerario-servico-tela-"]');
  const list = page.getByTestId('itinerario-lista-servicos');
  await expect(list.or(anyScreen).first()).toBeVisible({ timeout: 15_000 });
  if (await target.isVisible()) return;
  if (await anyScreen.first().isVisible()) await page.getByTestId('itinerario-voltar-servicos').click();
  await page.getByTestId(`itinerario-cartao-abrir-${serviceId}`).click();
  await expect(target).toBeVisible({ timeout: 15_000 });
}

/** Aba interna "Horario fijo" do serviço (a agenda semanal editável; onde moram `itinerario-slot-*`). */
export async function openFixedSchedule(page: Page, serviceId: string): Promise<void> {
  await openServiceScreen(page, serviceId);
  await page.getByTestId('itinerario-aba-fixed').click();
  await expect(page.getByTestId('itinerario-horario-fijo')).toBeVisible({ timeout: 15_000 });
}

/** Aba interna "Próximos días" (a padrão): espera a tabela (ou o vazio) da semana. */
export async function openUpcomingDays(page: Page, serviceId: string): Promise<void> {
  await openServiceScreen(page, serviceId);
  await page.getByTestId('itinerario-aba-upcoming').click();
  await expect(page.getByTestId('itinerario-proximos-tabela').or(page.getByTestId('itinerario-proximos-vazio'))).toBeVisible({ timeout: 15_000 });
}

/** Aba interna "Sustituciones": espera a lista (ou o estado vazio). */
export async function openSubstitutions(page: Page, serviceId: string): Promise<void> {
  await openServiceScreen(page, serviceId);
  await page.getByTestId('itinerario-aba-substitutions').click();
  await expect(page.getByTestId('sustituciones-lista').or(page.getByTestId('sustituciones-vacio'))).toBeVisible({ timeout: 15_000 });
}

/**
 * "Horas cubiertas: X de Y h" do cabeçalho do serviço aberto (era o par `X/Y` da seção da aba antiga): a MESMA conta do Kanban, lida da TELA.
 * `par` = `cobertas/total` (ex.: '20/40'). A tela do serviço certo tem de estar aberta (`openServiceScreen`).
 */
export async function expectHorasCubiertas(page: Page, par: string, timeout = 10_000): Promise<void> {
  const [cobertas, total] = par.split('/');
  await expect(page.getByTestId('itinerario-servico-horas')).toHaveText(`Horas cubiertas: ${cobertas} de ${total} h`, { timeout });
}
