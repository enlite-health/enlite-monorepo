import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@infrastructure/i18n/config';
import { CountryChips } from '../CountryChips';

beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => cleanup());

describe('CountryChips', () => {
  it('o país É o botão: marcado = ✓ e aria-pressed; o nome sai por extenso', () => {
    render(<CountryChips countries={['AR', 'BR']} selected={['BR']} onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Brasil ✓' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Argentina' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicar chama onToggle com o país e o estado NOVO (liga/desliga)', async () => {
    const onToggle = vi.fn();
    render(<CountryChips countries={['AR', 'BR']} selected={['BR']} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('button', { name: 'Argentina' }));
    await userEvent.click(screen.getByRole('button', { name: 'Brasil ✓' }));
    expect(onToggle).toHaveBeenNthCalledWith(1, 'AR', true);
    expect(onToggle).toHaveBeenNthCalledWith(2, 'BR', false);
  });

  it('readOnly vira TEXTO (sem botão), e renderChip troca o botão (como o ActionButton de Accesos)', () => {
    const { rerender } = render(<CountryChips countries={['AR', 'BR']} selected={['AR']} readOnly />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Argentina ✓')).toBeInTheDocument();
    rerender(
      <CountryChips countries={['AR']} selected={[]} renderChip={({ country, onToggle }) => <a data-testid={`custom-${country}`} onClick={onToggle}>x</a>} />,
    );
    expect(screen.getByTestId('custom-AR')).toBeInTheDocument();
  });
});
