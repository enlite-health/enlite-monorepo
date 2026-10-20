/**
 * dateRangeWire.test.ts — spec 058 T046. Teste de contrato da conversão daterange `[)` <-> wire (única dona).
 * Os 4 testes numerados (i–iv) são os que a SABOTAGEM "somar 1 dia a validTo em toWire" derruba; os demais não dependem de validTo não nulo.
 */
import { dayAfter, fromWire, isSameStart, reinsertClosed, toWire } from '../dateRangeWire';

describe('dateRangeWire', () => {
  it('(i) fronteira de 1 dia: [2026-03-01,2026-04-01) <-> validTo 2026-03-31 (inclusivo no fio, exclusivo no banco)', () => {
    expect(toWire('[2026-03-01,2026-04-01)')).toEqual({ validFrom: '2026-03-01', validTo: '2026-03-31' });
    expect(fromWire({ validFrom: '2026-03-01', validTo: '2026-03-31' })).toBe('[2026-03-01,2026-04-01)');
    expect(toWire('[2026-02-01,2026-03-01)').validTo).toBe('2026-02-28'); // vira de mês
    expect(toWire('[2024-02-01,2024-03-01)').validTo).toBe('2024-02-29'); // bissexto
    expect(toWire('[2025-12-01,2026-01-01)').validTo).toBe('2025-12-31'); // vira de ano
    for (const r of ['[2026-03-01,2026-04-01)', '[2024-02-29,2024-03-01)']) expect(fromWire(toWire(r))).toBe(r); // ida e volta fechada
  });

  it('(ii) SAME_START: novo vínculo no mesmo dia do vivo é recusado; no dia seguinte ao validTo do vivo fechado não é', () => {
    expect(isSameStart('2026-03-01', '2026-03-01')).toBe(true);        // => SAME_START_USE_CORRECTION
    expect(reinsertClosed('2026-03-01', '2026-03-01')).toBeNull();     // o reinsert ficaria vazio
    const fechado = toWire('[2026-03-01,2026-04-01)');                  // vigente até 31/03
    expect(isSameStart(fechado.validFrom, dayAfter(fechado.validTo as string))).toBe(false); // 01/04: troca normal
    expect(dayAfter(fechado.validTo as string)).toBe('2026-04-01');
  });

  it('(iii) reinsertClosed = [lower, fim) e vazio quando lower = newFrom', () => {
    expect(reinsertClosed('2026-01-01', '2026-03-01')).toBe('[2026-01-01,2026-03-01)');
    expect(toWire(reinsertClosed('2026-01-01', '2026-03-01') as string).validTo).toBe('2026-02-28');
    expect(reinsertClosed('2026-03-01', '2026-03-01')).toBeNull();
  });

  it('(iv) dia do NO_TERM = dia seguinte ao validTo do último termo', () => {
    const ultimo = toWire('[2026-01-01,2026-07-01)'); // último termo vigente até 30/06
    expect(ultimo.validTo).toBe('2026-06-30');
    expect(dayAfter(ultimo.validTo as string)).toBe('2026-07-01');
  });

  it('upper infinito <-> validTo null, nos dois sentidos', () => {
    expect(toWire('[2026-03-01,)')).toEqual({ validFrom: '2026-03-01', validTo: null });
    expect(fromWire({ validFrom: '2026-03-01', validTo: null })).toBe('[2026-03-01,)');
  });

  it('entrada inválida lança: daterange vazio/fechado à direita, data fora de AAAA-MM-DD, validTo antes de validFrom, newFrom antes do início', () => {
    expect(() => toWire('empty')).toThrow(/fora do formato/);
    expect(() => toWire('[2026-03-01,2026-04-01]')).toThrow(/fora do formato/);
    expect(() => fromWire({ validFrom: '01/03/2026', validTo: null })).toThrow(/ISO/);
    expect(() => fromWire({ validFrom: '2026-03-02', validTo: '2026-03-01' })).toThrow(/anterior/);
    expect(() => reinsertClosed('2026-03-01', '2026-02-01')).toThrow(/anterior/);
  });

  it('ida e volta de faixa aberta: fromWire(toWire(x)) = x', () => {
    expect(fromWire(toWire('[2026-03-01,)'))).toBe('[2026-03-01,)');
  });
});
