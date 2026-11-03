import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CustosKpis } from '../CustosKpis';
import { CustosMeses } from '../CustosMeses';
import { overview, usarIdioma } from './custosTestUtils';

describe('CustosKpis (RF-A8)', () => {
  beforeEach(async () => { await usarIdioma('pt-BR'); });

  it('3 números: mês até agora, previsão com a conta, e +27,3% contra o mês anterior no mesmo dia', () => {
    render(<CustosKpis ov={overview()} />);
    expect(screen.getByTestId('custos-card-mes-valor')).toHaveTextContent(/US\$\s?1\.148,40/);
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('1 a 18 de outubro');
    expect(screen.getByTestId('custos-card-previsao-valor')).toHaveTextContent(/US\$\s?2\.094,14/);
    expect(screen.getByTestId('custos-card-previsao-base').textContent).toContain('Estimativa linear: gasto de 17 dias × 31 ÷ 17.');
    expect(screen.getByTestId('custos-card-previsao-base').textContent).toMatch(/\+30%.*mês anterior fechado \(US\$\s?1\.611,30\)/);
    expect(screen.getByTestId('custos-card-variacao-valor')).toHaveTextContent('+27,3%');
    expect(screen.getByTestId('custos-card-variacao')).toHaveTextContent(/Setembro, 1 a 18: US\$\s?902,10/);
  });

  it('D5: o rótulo "1 a N" segue o dia do DADO (dataUntil, parcial incluído), não os dias completos da previsão', () => {
    // monthTotal inclui o dia parcial 18; daysCounted = 17 (completos). O rótulo diz 18 e a base da previsão continua dizendo 17.
    render(<CustosKpis ov={overview({ dataUntil: '2026-10-18T06:12:00Z', forecast: { value: 2094.14, basis: 'linear', daysCounted: 17 } })} />);
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('1 a 18 de outubro');
    expect(screen.getByTestId('custos-card-mes').textContent).not.toContain('1 a 17');
    expect(screen.getByTestId('custos-card-previsao-base').textContent).toContain('gasto de 17 dias');
  });

  it('D2: mês fechado = 2 cartões ("Total do mês" e "Contra o mês anterior" com o mês anterior INTEIRO), sem previsão', () => {
    render(<CustosKpis ov={overview({ month: '2026-09', dataUntil: '2026-10-18T06:12:00Z', prevMonthToDate: 1000, prevMonthTotal: 1000, monthTotal: 1250, forecast: { value: null, basis: 'linear', daysCounted: 0 }, anomalies: { status: 'not_applicable' as const, day: null, rule: { factor: 2, minDelta: 5, windowDays: 7 }, items: [] } })} />);
    expect(screen.queryByTestId('custos-card-previsao')).toBeNull();
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('Total do mês');
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('Setembro');
    expect(screen.getByTestId('custos-card-mes').textContent).not.toMatch(/1 a \d+ de/);
    expect(screen.getByTestId('custos-card-variacao')).toHaveTextContent('Contra o mês anterior');
    expect(screen.getByTestId('custos-card-variacao').textContent).not.toContain('mesmo dia');
    expect(screen.getByTestId('custos-card-variacao-valor')).toHaveTextContent('+25%');
    expect(screen.getByTestId('custos-card-variacao')).toHaveTextContent(/Agosto, inteiro: US\$\s?1\.000,00/);
    expect(screen.getByTestId('custos-kpis').className).toContain('md:grid-cols-2');
  });

  it('valor null mostra "—" com a razão, NUNCA 0', () => {
    render(<CustosKpis ov={overview({ prevMonthToDate: null, prevMonthTotal: null, forecast: { value: null, basis: 'linear', daysCounted: 0 } })} />);
    expect(screen.getByTestId('custos-card-previsao-valor')).toHaveTextContent('—');
    expect(screen.getByTestId('custos-card-previsao')).toHaveTextContent('Sem dias suficientes para estimar');
    expect(screen.getByTestId('custos-card-variacao-valor')).toHaveTextContent('—');
    expect(screen.getByTestId('custos-card-variacao-razao')).toHaveTextContent('Sem dado do mês anterior ainda.');
    expect(screen.getByTestId('custos-card-previsao-valor').textContent).not.toMatch(/0/);
  });

  it('poucos dias de dado: selo "estimativa com N dias" e "1 e 2 de <mês>"', () => {
    render(<CustosKpis ov={overview({ month: '2026-11', forecast: { value: 2011.5, basis: 'linear', daysCounted: 2 }, prevMonthToDate: null })} />);
    expect(screen.getByTestId('custos-selo-estimativa')).toHaveTextContent('estimativa com 2 dias');
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('1 e 2 de novembro');
  });
});

describe('CustosMeses (RF-A11)', () => {
  beforeEach(async () => { await usarIdioma('pt-BR'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-18T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('6 meses com valor em TEXTO; o mês corrente é parcial e leva a barra da previsão com "prev. <valor>"', () => {
    render(<CustosMeses ov={overview()} />);
    expect(screen.getByTestId('custos-mes-2026-05')).toHaveTextContent(/US\$\s?1\.020,40/);
    const atual = screen.getByTestId('custos-mes-2026-10');
    expect(atual).toHaveTextContent('(parcial)');
    expect(within(atual).getByTestId('custos-mes-previsao-2026-10')).toHaveTextContent(/prev\. US\$\s?2\.094,14/);
    expect(within(atual).getByTestId('custos-mes-barra-previsao-2026-10')).toBeInTheDocument();
    expect(screen.getByTestId('custos-mes-barra-2026-09')).toBeInTheDocument();
  });

  it('mês fechado (não é o corrente) não ganha previsão', () => {
    render(<CustosMeses ov={overview({ month: '2026-09', months: overview().months.slice(0, 5) })} />);
    expect(screen.queryByTestId('custos-mes-barra-previsao-2026-09')).toBeNull();
    expect(screen.getByTestId('custos-mes-2026-09')).not.toHaveTextContent('(parcial)');
  });
});
