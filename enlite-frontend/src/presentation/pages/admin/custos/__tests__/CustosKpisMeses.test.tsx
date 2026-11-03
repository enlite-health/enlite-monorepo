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
    expect(screen.getByTestId('custos-card-mes')).toHaveTextContent('1 a 17 de outubro');
    expect(screen.getByTestId('custos-card-previsao-valor')).toHaveTextContent(/US\$\s?2\.094,14/);
    expect(screen.getByTestId('custos-card-previsao-base').textContent).toContain('Estimativa linear: gasto de 17 dias × 31 ÷ 17.');
    expect(screen.getByTestId('custos-card-previsao-base').textContent).toMatch(/\+30%.*mês anterior fechado \(US\$\s?1\.611,30\)/);
    expect(screen.getByTestId('custos-card-variacao-valor')).toHaveTextContent('+27,3%');
    expect(screen.getByTestId('custos-card-variacao')).toHaveTextContent(/Setembro, 1 a 17: US\$\s?902,10/);
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
