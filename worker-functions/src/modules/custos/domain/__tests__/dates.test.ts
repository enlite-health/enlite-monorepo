import { buildWindow } from '../dates';

describe('buildWindow — janela diária relativa ao MÊS pedido (DF-22)', () => {
  it('mês corrente: 15 dias terminando hoje (inclusive)', () => {
    const w = buildWindow('2026-10', '2026-10-20');
    expect(w.dailyFrom).toBe('2026-10-06');
    expect(w.dailyToExclusive).toBe('2026-10-21');
  });

  it('mês fechado: 15 dias terminando no ÚLTIMO dia do mês pedido, nunca contados a partir de hoje', () => {
    const w = buildWindow('2026-08', '2026-10-20');
    expect(w.dailyToExclusive).toBe('2026-09-01');
    expect(w.dailyFrom).toBe('2026-08-17');
    // âncora de availableMonths continua sendo hoje
    expect(w.availableToExclusive).toBe('2026-10-21');
  });
});
