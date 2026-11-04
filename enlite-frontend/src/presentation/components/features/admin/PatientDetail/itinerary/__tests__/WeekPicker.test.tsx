/**
 * WeekPicker + WeekCalendar — spec 069, FR-05: UM controle (pílula ‹ calendário ›), texto relativo e
 * "Ir a esta semana"; qualquer dia do calendário seleciona a SEMANA dele (segunda a domingo); sem teto.
 * i18n real; as datas vêm sempre como string (nenhum relógio do navegador entra).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { initI18n, i18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { WeekPicker } from '../WeekPicker';

beforeAll(async () => {
  await initI18n('es');
});

const CURRENT = '2026-10-19';

function renderPicker(weekStart: string, onChange = vi.fn()) {
  const utils = render(<WeekPicker weekStart={weekStart} currentWeekStart={CURRENT} onChange={onChange} />);
  return { ...utils, onChange };
}

describe('WeekPicker — a pílula', () => {
  it('mostra "2 al 8 de noviembre" e o relativo "En 2 semanas" (mockup b2a)', () => {
    const { container } = renderPicker('2026-11-02');
    expect(screen.getByTestId('itinerario-semana-rotulo')).toHaveTextContent('2 al 8 de noviembre');
    expect(screen.getByTestId('itinerario-semana-relativo')).toHaveTextContent('En 2 semanas');
    expectNoRawEnumLeaks(container);
  });

  it('semana que cruza o mês: "26 de octubre al 1 de noviembre"', () => {
    renderPicker('2026-10-26');
    expect(screen.getByTestId('itinerario-semana-rotulo')).toHaveTextContent('26 de octubre al 1 de noviembre');
  });

  it.each([
    ['2026-10-19', 'Esta semana'],
    ['2026-10-26', 'La semana que viene'],
    ['2026-10-12', 'La semana pasada'],
    ['2026-11-09', 'En 3 semanas'],
    ['2026-09-28', 'Hace 3 semanas'],
  ])('relativo de %s = %s', (week, text) => {
    renderPicker(week);
    expect(screen.getByTestId('itinerario-semana-relativo')).toHaveTextContent(text);
  });

  it('‹ e › andam 7 dias; "Ir a esta semana" volta à corrente (segunda de asOf)', () => {
    const { onChange } = renderPicker('2026-11-02');
    fireEvent.click(screen.getByTestId('itinerario-semana-anterior'));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-26');
    fireEvent.click(screen.getByTestId('itinerario-semana-seguinte'));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-09');
    fireEvent.click(screen.getByTestId('itinerario-semana-atual'));
    expect(onChange).toHaveBeenLastCalledWith(CURRENT);
  });

  it('pt-BR: rótulo e relativo no idioma ativo', async () => {
    await i18n.changeLanguage('pt-BR');
    renderPicker('2026-11-02');
    expect(screen.getByTestId('itinerario-semana-rotulo')).toHaveTextContent('2 a 8 de novembro');
    expect(screen.getByTestId('itinerario-semana-relativo')).toHaveTextContent('Em 2 semanas');
    await act(async () => {
      await i18n.changeLanguage('es');
    });
  });
});

describe('WeekCalendar — o calendário aberto', () => {
  const abrir = () => fireEvent.click(screen.getByTestId('itinerario-semana-abrir'));

  it('abre no mês da semana, com a semana INTEIRA destacada (as pontas em círculo cheio)', () => {
    renderPicker('2026-11-02');
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();
    abrir();
    expect(screen.getByTestId('itinerario-semana-calendario')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-semana-mes')).toHaveTextContent(/noviembre de 2026/i);
    for (const d of ['02', '03', '04', '05', '06', '07', '08']) {
      expect(screen.getByTestId(`itinerario-semana-dia-2026-11-${d}`)).toHaveAttribute('aria-pressed', 'true');
    }
    expect(screen.getByTestId('itinerario-semana-dia-2026-11-09')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('itinerario-semana-dia-2026-11-02').className).toContain('bg-primary');
    expect(screen.getByTestId('itinerario-semana-dia-2026-11-08').className).toContain('bg-primary');
    expect(screen.getByTestId('itinerario-semana-dia-2026-11-05').className).not.toContain('bg-primary');
    expect(screen.getByTestId('itinerario-semana-calendario-faixa')).toHaveTextContent('Semana del 2 al 8');
  });

  it('grade começa na segunda (L M M J V S D) e mostra os dias do mês vizinho (26 … 31 de octubre)', () => {
    renderPicker('2026-11-02');
    abrir();
    const header = screen.getByTestId('itinerario-semana-calendario');
    expect(header).toHaveTextContent('LMMJVSD');
    expect(screen.getByTestId('itinerario-semana-dia-2026-10-26')).toHaveTextContent('26');
    expect(screen.getByTestId('itinerario-semana-dia-2026-12-06')).toHaveTextContent('6');
  });

  it('clicar em QUALQUER dia seleciona a segunda da semana dele e fecha (20 semanas à frente, sem teto)', () => {
    const { onChange } = renderPicker('2026-11-02');
    abrir();
    // 20 semanas depois de 19/10 = 8/03/2027: navegar mês a mês até lá
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByTestId('itinerario-semana-mes-seguinte'));
    expect(screen.getByTestId('itinerario-semana-mes')).toHaveTextContent(/marzo de 2027/i);
    fireEvent.click(screen.getByTestId('itinerario-semana-dia-2027-03-10'));
    expect(onChange).toHaveBeenCalledWith('2027-03-08');
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();
  });

  it('mês anterior/seguinte mudam só o mês mostrado (a seleção não muda)', () => {
    const { onChange } = renderPicker('2026-11-02');
    abrir();
    fireEvent.click(screen.getByTestId('itinerario-semana-mes-anterior'));
    expect(screen.getByTestId('itinerario-semana-mes')).toHaveTextContent(/octubre de 2026/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('"Ir a esta semana" do calendário seleciona a semana corrente e fecha', () => {
    const { onChange } = renderPicker('2026-11-02');
    abrir();
    fireEvent.click(screen.getByTestId('itinerario-semana-calendario-hoje'));
    expect(onChange).toHaveBeenCalledWith(CURRENT);
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();
  });

  it('Esc fecha; clique fora fecha; clique dentro NÃO fecha; clicar de novo no botão alterna (não reabre)', () => {
    renderPicker('2026-11-02');
    abrir();
    fireEvent.mouseDown(screen.getByTestId('itinerario-semana-calendario'));
    expect(screen.getByTestId('itinerario-semana-calendario')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('itinerario-semana-calendario')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();

    abrir();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();

    // o botão que abre: mousedown nele NÃO fecha sozinho (senão o click reabriria); o click alterna
    abrir();
    fireEvent.mouseDown(screen.getByTestId('itinerario-semana-abrir'));
    expect(screen.getByTestId('itinerario-semana-calendario')).toBeInTheDocument();
    abrir();
    expect(screen.queryByTestId('itinerario-semana-calendario')).toBeNull();
  });

  it('aria: o botão anuncia o diálogo e cada dia tem o nome por extenso', () => {
    renderPicker('2026-11-02');
    expect(screen.getByTestId('itinerario-semana-abrir')).toHaveAttribute('aria-expanded', 'false');
    abrir();
    expect(screen.getByTestId('itinerario-semana-abrir')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-semana-dia-2026-11-02')).toHaveAttribute('aria-label', 'lunes, 2 de noviembre');
  });
});
