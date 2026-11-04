/**
 * SaleEntraBlock — spec 069, US6 aceite 5 e 8: o MESMO bloco na linha da lista e no resumo do fluxo; papel de quem entra com a bolinha
 * (verde = en atención, azul = respuesta rápida, sem bolinha = seleccionado); sem cor sozinha.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { initI18n } from './i18nSetup';
import { SaleEntraBlock } from '../SaleEntraBlock';

beforeAll(async () => {
  await initI18n('es');
});

const SALE = { workerId: 'w-lucia', displayName: 'Lucía Fernández', caption: 'Vacaciones' };

describe('SaleEntraBlock', () => {
  it.each([
    ['QUICK_RESPONSE', 'Respuesta rápida', true],
    ['IN_SERVICE', 'En atención', true],
    ['SELECTED', 'Seleccionado', false],
  ] as const)('papel %s → "%s", bolinha: %s', (role, text, dot) => {
    render(<SaleEntraBlock data-testid="b" sale={SALE} entra={[{ workerId: 'w-martin', displayName: 'Martín Gómez', role }]} />);
    const papel = screen.getByTestId('b-papel');
    expect(papel).toHaveTextContent(text);
    expect(papel.querySelector('span[aria-hidden="true"]') !== null).toBe(dot);
  });

  it('sem papel conhecido (a lista não o traz): só o nome; várias pessoas: nomes juntos, sem papel', () => {
    const a = render(<SaleEntraBlock data-testid="b" sale={{ ...SALE, caption: null }} entra={[{ workerId: 'w-martin', displayName: 'Martín Gómez' }]} />);
    expect(screen.queryByTestId('b-papel')).toBeNull();
    expect(screen.getByTestId('b-sale')).toHaveTextContent(/^LFLucía Fernández$/);
    a.unmount();
    render(<SaleEntraBlock data-testid="b" sale={SALE} entra={[{ workerId: 'w-m', displayName: 'Martín Gómez', role: 'SELECTED' }, { workerId: 'w-b', displayName: null }]} />);
    expect(screen.getByTestId('b-entra')).toHaveTextContent('Martín Gómez, Prestador sin nombre');
    expect(screen.queryByTestId('b-papel')).toBeNull();
  });

  it('sem testid: nenhum data-testid derivado; "Nadie todavía" sem onPick não mostra o botão', () => {
    const { container } = render(<SaleEntraBlock sale={SALE} entra={[]} />);
    expect(container.querySelector('[data-testid]:not([data-testid="person-avatar"])')).toBeNull();
    expect(container).toHaveTextContent('Nadie todavía');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('com o papel mas sem testid: o papel aparece e nenhum data-testid derivado', () => {
    const { container } = render(<SaleEntraBlock sale={SALE} entra={[{ workerId: 'w-martin', displayName: 'Martín Gómez', role: 'IN_SERVICE' }]} />);
    expect(container).toHaveTextContent('En atención');
    expect(container.querySelector('[data-testid]:not([data-testid="person-avatar"])')).toBeNull();
  });

  it('"Nadie todavía" com onPick: o botão chama onPick; com entra e `onPick`, o botão não existe (alguém já entra)', () => {
    const onPick = vi.fn();
    const a = render(<SaleEntraBlock sale={SALE} entra={[]} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Elegir quién entra' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    a.unmount();
    render(<SaleEntraBlock sale={SALE} entra={[{ workerId: 'w-martin', displayName: 'Martín Gómez' }]} onPick={onPick} uncoveredLabels={['lun 9']} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('salvo lun 9: nadie')).toBeInTheDocument();
  });
});
