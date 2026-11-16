import { expect, type Locator } from '@playwright/test';

/**
 * Combobox do front (`atoms/Combobox`, spec 070): o GATILHO é um `<button role="combobox">` e o
 * painel (`ul[role=listbox]` > `li[role=option][data-value]`) é irmão dele, dentro do mesmo
 * contêiner. Substitui o `<select>` nativo: `selectOption`/`locator('option')` não valem mais.
 *
 * ESCOPO: as opções são buscadas DENTRO do listbox deste combobox. `page.getByRole('option')` solto
 * também pega os `<option>` de `<select>` nativos (role implícito) — ver vaga-ciclo-staff.regression.ts.
 */
function painelDe(gatilho: Locator): Locator {
  return gatilho.locator('xpath=..').getByRole('listbox');
}

/** Abre o gatilho (se ainda fechado) e devolve o listbox. Gesto humano: um clique. */
async function abrir(gatilho: Locator): Promise<Locator> {
  if ((await gatilho.getAttribute('aria-expanded')) !== 'true') await gatilho.click();
  const painel = painelDe(gatilho);
  await expect(painel, 'o combobox abriu a lista de opções').toBeVisible({ timeout: 10_000 });
  return painel;
}

/** Abre o combobox, clica a opção pelo rótulo que a pessoa lê e confere que o gatilho o mostra. */
export async function escolherNoCombobox(gatilho: Locator, rotulo: string): Promise<void> {
  const painel = await abrir(gatilho);
  await painel.getByRole('option', { name: rotulo, exact: true }).click();
  await expect(gatilho).toContainText(rotulo);
}

/**
 * Abre o combobox e LÊ as opções reais da tela (`data-value` + rótulo), sem escolher nenhuma; as de
 * valor vazio (a linha "limpar") ficam de fora. Deixa o painel aberto — quem chama escolhe em seguida.
 */
export async function lerOpcoesDoCombobox(gatilho: Locator): Promise<Array<{ value: string; label: string }>> {
  const painel = await abrir(gatilho);
  const opcoes = await painel
    .getByRole('option')
    .evaluateAll((lis) =>
      lis.map((li) => ({ value: li.getAttribute('data-value') ?? '', label: (li.textContent ?? '').trim() })),
    );
  return opcoes.filter((o) => o.value !== '');
}

/**
 * Combobox `multiple`: abre, marca a 1ª opção e fecha. Escolher NÃO fecha o painel nesse modo; ele
 * fecha por `mousedown` FORA (`Escape` não fecha, medido) — e fechar importa porque o painel aberto
 * cobre o campo seguinte.
 */
export async function marcarPrimeiraOpcaoDoCombobox(gatilho: Locator): Promise<void> {
  const painel = await abrir(gatilho);
  await painel.getByRole('option').first().click();
  await gatilho.page().mouse.click(5, 5);
}
