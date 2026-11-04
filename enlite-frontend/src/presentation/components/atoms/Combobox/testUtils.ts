import { fireEvent, screen, within } from '@testing-library/react';
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

/**
 * Versões SÍNCRONAS (fireEvent) para os testes de página que já são síncronos:
 * o gesto é o mesmo (abrir o gatilho, clicar a opção pelo rótulo).
 */
export function chooseCombo(trigger: HTMLElement, label: string | RegExp): void {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const listbox = trigger.parentElement!.querySelector('ul[role="listbox"]') as HTMLElement;
  fireEvent.click(within(listbox).getByRole('option', { name: label }).querySelector('button')!);
}

/** Rótulos das linhas do painel (abre o gatilho se estiver fechado), na ordem exibida. */
export function comboLabels(trigger: HTMLElement): string[] {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const listbox = trigger.parentElement!.querySelector('ul[role="listbox"]');
  return Array.from(listbox?.querySelectorAll('[role="option"]') ?? []).map((o) => o.textContent ?? '');
}
