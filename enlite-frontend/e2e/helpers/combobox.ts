/**
 * combobox.ts — escolher opção no `Combobox` (spec 070) como a pessoa faz: abre o gatilho, busca (quando há campo de busca) e clica
 * a opção pelo RÓTULO que ela lê. Só gestos de clique e teclado (o gatilho é um `button`, não um `<select>`).
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** `alvo` pode ser o próprio gatilho (`button`) ou uma raiz que o contém. */
async function resolverGatilho(alvo: Locator | string, page: Page): Promise<Locator> {
  const raiz = typeof alvo === 'string' ? page.locator(alvo) : alvo;
  const ehGatilho = await raiz.evaluate((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox');
  return ehGatilho ? raiz : raiz.locator('button[aria-haspopup="listbox"]').first();
}

/** Abre o painel e, se houver campo de busca, digita o termo. Devolve o gatilho. */
async function abrir(page: Page, alvo: Locator | string, termo?: string): Promise<Locator> {
  const gatilho = await resolverGatilho(alvo, page);
  await gatilho.click();
  const busca = page.locator('input[data-testid$="-search"]');
  if (termo !== undefined && (await busca.count()) > 0) {
    await expect(busca).toBeFocused();
    await page.keyboard.type(termo);
  }
  return gatilho;
}

/** Combobox de escolha única: o gatilho passa a mostrar o `rotulo`. */
export async function escolherNoCombo(
  page: Page,
  alvo: Locator | string,
  rotulo: string,
  opts?: { buscar?: string },
): Promise<void> {
  const gatilho = await abrir(page, alvo, opts?.buscar ?? rotulo);
  await page.getByRole('option', { name: rotulo, exact: true }).click();
  await expect(gatilho).toContainText(rotulo);
}

/** Combobox `multiple`: marca cada rótulo (o painel fica aberto) e fecha com Esc no fim. */
export async function escolherVariosNoCombo(page: Page, alvo: Locator | string, rotulos: string[]): Promise<void> {
  const gatilho = await abrir(page, alvo);
  const busca = page.locator('input[data-testid$="-search"]');
  for (const rotulo of rotulos) {
    if ((await busca.count()) > 0) {
      await busca.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(rotulo);
    }
    await page.getByRole('option', { name: rotulo, exact: true }).click();
  }
  await page.keyboard.press('Escape');
  await expect(gatilho).toBeVisible();
}
