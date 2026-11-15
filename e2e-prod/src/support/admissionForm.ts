import { expect, type Page } from '@playwright/test';

/**
 * `lead-serviceType` do formulário público de admissão virou Combobox (spec 070): o `data-testid`
 * está no PRÓPRIO gatilho (`button[aria-haspopup=listbox]`, medido em prd 15/11) e o painel é seu
 * irmão dentro do mesmo contêiner. Gesto humano: abre o gatilho e clica a opção pelo rótulo que a
 * pessoa lê (es: "Cuidadores").
 *
 * ESCOPO: a opção é buscada DENTRO do listbox deste combobox. `page.getByRole('option')` solto
 * também pega os `<option>` de `<select>` nativos (role implícito) — ver vaga-ciclo-staff.regression.ts.
 */
export async function escolherServico(page: Page, rotulo: string): Promise<void> {
  const gatilho = page.getByTestId('lead-serviceType');
  const combo = gatilho.locator('xpath=..');
  await gatilho.click();
  await combo.getByRole('listbox').getByRole('option', { name: rotulo, exact: true }).click();
  await expect(gatilho).toContainText(rotulo);
}
