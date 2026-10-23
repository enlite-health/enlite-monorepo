import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Escolhe `label` num `Combobox` como o usuário faz: clica o gatilho (achado
 * pelo nome acessível, ou passado direto) e clica a opção pelo rótulo. Substitui o
 * `userEvent.selectOptions` dos testes de página (spec 070).
 */
export async function selectCombo(
  name: string | RegExp | HTMLElement,
  label: string | RegExp,
): Promise<void> {
  const user = userEvent.setup();
  // `name` pode ser o próprio gatilho (achado por testid/id) quando o rótulo acessível não ajuda
  await user.click(name instanceof HTMLElement ? name : screen.getByRole('combobox', { name }));
  const listbox = screen.getByRole('listbox');
  // o clique real cai no <button> que preenche o <li role=option>
  await user.click(within(listbox).getByRole('option', { name: label }).querySelector('button')!);
}
