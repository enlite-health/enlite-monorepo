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

/** Campo de busca DESTE combobox (irmão do gatilho no mesmo contêiner) — nunca um `*-search` de outro campo da página. */
function buscaDo(gatilho: Locator): Locator {
  return gatilho.locator('xpath=..').locator('input[data-testid$="-search"]');
}

/** Abre o painel e, se houver campo de busca, digita o termo. Devolve o gatilho. */
async function abrir(page: Page, alvo: Locator | string, termo?: string): Promise<Locator> {
  const gatilho = await resolverGatilho(alvo, page);
  await gatilho.click();
  const busca = buscaDo(gatilho);
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

/**
 * Combobox de AÇÃO: o gatilho não guarda a escolha (ex.: "Ver como grupo" no rodapé da sidebar, que dispara a simulação e segue
 * mostrando o placeholder). Mesmo gesto — abrir, buscar, clicar a opção pelo rótulo —, sem conferir o texto do gatilho; o efeito
 * (banner, menu) é a asserção do teste.
 */
export async function acionarNoCombo(page: Page, alvo: Locator | string, rotulo: string, opts?: { buscar?: string }): Promise<void> {
  await abrir(page, alvo, opts?.buscar ?? rotulo);
  await page.getByRole('option', { name: rotulo, exact: true }).click();
}

/**
 * Combobox de escolha única quando o teste só conhece o VALOR (código/id de seed, ex.: `OTHER`, o id de um prestador) e não o rótulo:
 * abre o gatilho e clica a linha cujo `data-value` é o valor. O gesto continua sendo o clique humano na linha do painel.
 */
export async function escolherNoComboPorValor(page: Page, alvo: Locator | string, valor: string): Promise<void> {
  const gatilho = await abrir(page, alvo);
  await page.locator(`ul[role="listbox"] li[role="option"][data-value="${valor}"] button`).click();
  await expect(gatilho).toHaveAttribute('aria-expanded', 'false');
}

/** Combobox `multiple`: marca cada rótulo (o painel fica aberto) e fecha com Esc no fim. */
export async function escolherVariosNoCombo(page: Page, alvo: Locator | string, rotulos: string[]): Promise<void> {
  const gatilho = await abrir(page, alvo);
  const busca = buscaDo(gatilho);
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

/**
 * Abre o `Combobox` e clica a 1ª linha do painel (para jornadas que só precisam de "qualquer valor").
 * Pensado para `multiple` sem `clearLabel` (a 1ª linha é uma opção de verdade); fecha com Esc.
 * Devolve `false` sem falhar se o gatilho não aparece (mesma tolerância dos helpers antigos de jornada).
 */
export async function escolherPrimeiroNoCombo(page: Page, alvo: Locator | string): Promise<boolean> {
  const raiz = typeof alvo === 'string' ? page.locator(alvo) : alvo;
  if (!(await raiz.first().isVisible({ timeout: 5_000 }).catch(() => false))) return false;
  const gatilho = await resolverGatilho(raiz.first(), page);
  await gatilho.click();
  await page.locator('ul[role="listbox"] li[role="option"] button').first().click();
  await page.keyboard.press('Escape');
  return true;
}

/** Rótulo do mês como o seletor de Horas Ana Care o exibe (`formatMonthLabel`): "Septiembre 2026". */
export function rotuloDoMes(mesIso: string, locale = 'es'): string {
  const [ano, mes] = mesIso.split('-').map(Number);
  const nome = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(ano, mes - 1, 1)));
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} ${ano}`;
}

/** Inverso de `rotuloDoMes`: "Septiembre 2026" → "2026-09" (o painel mostra só o rótulo, o valor ISO não vai à tela). */
export function mesIsoDoRotulo(rotulo: string, locale = 'es'): string {
  const ano = Number(rotulo.trim().split(/\s+/).pop());
  for (let m = 1; m <= 12; m += 1) {
    const iso = `${ano}-${String(m).padStart(2, '0')}`;
    if (rotuloDoMes(iso, locale) === rotulo.trim()) return iso;
  }
  throw new Error(`rótulo de mês desconhecido: "${rotulo}"`);
}
