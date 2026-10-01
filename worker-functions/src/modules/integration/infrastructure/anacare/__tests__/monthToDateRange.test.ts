/**
 * Spec 036 CA-1 — `monthToDateRange` devolve janela com FIM EXCLUSIVO (`maxDateExclusive` = 1º dia do
 * mês seguinte), porque o Ana Care trata `max_date` como exclusivo (medido). `toEqual` no objeto
 * inteiro: a chave antiga `maxDate` reprova também.
 */
import { monthToDateRange } from '../AnaCareSessionClient';

describe('monthToDateRange — fim exclusivo (Spec 036 CA-1)', () => {
  it.each([
    ['2026-09', { minDate: '2026-09-01', maxDateExclusive: '2026-10-01' }],
    ['2026-12', { minDate: '2026-12-01', maxDateExclusive: '2027-01-01' }], // vira o ano
    ['2028-02', { minDate: '2028-02-01', maxDateExclusive: '2028-03-01' }], // bissexto
    ['2026-02', { minDate: '2026-02-01', maxDateExclusive: '2026-03-01' }],
    ['2026-01', { minDate: '2026-01-01', maxDateExclusive: '2026-02-01' }],
  ])('%s', (month, expected) => {
    expect(monthToDateRange(month)).toEqual(expected);
  });
});
