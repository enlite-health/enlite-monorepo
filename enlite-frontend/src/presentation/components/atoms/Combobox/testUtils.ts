import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Escolhe `label` num `Combobox` como o usuário faz: clica o gatilho (achado
 * pelo nome acessível) e clica a opção pelo rótulo. Substitui o
 * `userEvent.selectOptions` dos testes de página (spec 070).
 */
export async function selectCombo(name: string | RegExp, label: string | RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  const listbox = screen.getByRole('listbox');
  // o clique real cai no <button> que preenche o <li role=option>
  await user.click(within(listbox).getByRole('option', { name: label }).querySelector('button')!);
}
