import { forecastMonth } from '../forecastMonth';

/** Outubro/2026 tem 31 dias. */
describe('forecastMonth (DF-6)', () => {
  it('mês parcial: líquido dos dias completos ÷ nº de dias completos × dias do mês', () => {
    // dias 1..10 completos, 10 por dia = 100 -> 100/10 * 31 = 310
    const daily = Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value: 10 }));
    expect(forecastMonth('2026-10', daily, '2026-10-10')).toEqual({ value: 310, basis: 'linear', daysCounted: 10 });
  });

  it('o dia parcial (depois do último completo) não entra na conta', () => {
    const daily = [
      { day: '2026-10-01', value: 10 }, { day: '2026-10-02', value: 10 },
      { day: '2026-10-03', value: 999 },
    ];
    expect(forecastMonth('2026-10', daily, '2026-10-02')).toEqual({ value: 310, basis: 'linear', daysCounted: 2 });
  });

  it('dia completo sem linha entra no divisor com custo 0', () => {
    const daily = [{ day: '2026-10-01', value: 20 }];
    // 3 dias completos (1..3), 20 no total -> 20/3 * 31
    const r = forecastMonth('2026-10', daily, '2026-10-03');
    expect(r.daysCounted).toBe(3);
    expect(r.value).toBeCloseTo((20 / 3) * 31);
  });

  it('mês sem dado -> value null', () => {
    expect(forecastMonth('2026-10', [], '2026-10-10')).toEqual({ value: null, basis: 'linear', daysCounted: 10 });
  });

  it('dia 1 (nenhum dia completo) -> null com 0 dias contados', () => {
    expect(forecastMonth('2026-10', [{ day: '2026-10-01', value: 5 }], '2026-09-30')).toEqual({ value: null, basis: 'linear', daysCounted: 0 });
    expect(forecastMonth('2026-10', [], null)).toEqual({ value: null, basis: 'linear', daysCounted: 0 });
  });

  it('mês já encerrado: previsão = total do mês', () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, value: 2 }));
    expect(forecastMonth('2026-09', daily, '2026-11-01')).toEqual({ value: 60, basis: 'linear', daysCounted: 30 });
  });
});
