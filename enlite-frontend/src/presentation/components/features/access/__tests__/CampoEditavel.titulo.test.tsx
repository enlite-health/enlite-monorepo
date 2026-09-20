/**
 * CampoEditavel `variant="titulo"` (Gabriel, 05/09, 2ª rodada): o valor é o título e o
 * lápis fica ao lado; a legenda só existe para o leitor de tela quando o campo abre.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampoEditavel } from '../CampoEditavel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const montar = (value: string | null, editable = true) => render(
  <CampoEditavel id="x" variant="titulo" valueId="x-valor" label="Nombre" value={value} editable={editable}
    sufixo={<span> · S</span>} onConfirm={() => true} onCancel={() => undefined}>
    <input id="x" />
  </CampoEditavel>,
);

describe('CampoEditavel — variant titulo', () => {
  it('valor vazio vira travessão no título; sufixo entra depois do valor; sem lápis quando não editável', () => {
    montar(null, false);
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2).toHaveTextContent('— · S');
    expect(document.getElementById('x-valor')).toHaveTextContent('—');
    expect(screen.queryByTestId('x-editar')).toBeNull();
    expect(screen.queryByText('Nombre')).toBeNull();
  });

  it('editável: título + lápis no mesmo bloco; abrir mostra o input com a legenda só para leitor de tela', async () => {
    montar('Grupo');
    const bloco = screen.getByTestId('x-readonly');
    expect(bloco).toContainElement(screen.getByTestId('x-editar'));
    expect(screen.queryByText('Nombre')).toBeNull();
    await userEvent.click(screen.getByTestId('x-editar'));
    const label = screen.getByText('Nombre');
    expect(label).toHaveClass('sr-only');
    expect(screen.getByLabelText('Nombre')).toBe(document.getElementById('x'));
  });
});
