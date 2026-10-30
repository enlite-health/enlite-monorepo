import {
  addCivilDays,
  isRealCivilDate,
  operationDateInZone,
  operationDateOf,
  utcCivilDayOf,
} from '../civilClock';

describe('civilClock', () => {
  describe('utcCivilDayOf', () => {
    it('lê o dia UTC da data civil (meia-noite UTC)', () => {
      expect(utcCivilDayOf(new Date('2026-10-29T00:00:00Z'))).toBe('2026-10-29');
    });
    it('23:59:59.999Z ainda é o mesmo dia civil UTC', () => {
      expect(utcCivilDayOf(new Date('2026-10-29T23:59:59.999Z'))).toBe('2026-10-29');
    });
  });

  describe('addCivilDays', () => {
    it('atravessa fim de ano', () => expect(addCivilDays('2026-12-20', 15)).toBe('2027-01-04'));
    it('n negativo', () => expect(addCivilDays('2026-03-01', -1)).toBe('2026-02-28'));
    it('ano bissexto', () => expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29'));
    it('n = 0 devolve o mesmo dia', () => expect(addCivilDays('2026-10-29', 0)).toBe('2026-10-29'));
  });

  describe('isRealCivilDate', () => {
    it('aceita data real', () => expect(isRealCivilDate('2028-02-29')).toBe(true));
    it('rejeita 30 de fevereiro (rolaria para março)', () => expect(isRealCivilDate('2026-02-30')).toBe(false));
    it('rejeita 29/02 em ano não bissexto', () => expect(isRealCivilDate('2027-02-29')).toBe(false));
    it('rejeita formato fora de AAAA-MM-DD', () => {
      expect(isRealCivilDate('2026-2-3')).toBe(false);
      expect(isRealCivilDate('')).toBe(false);
      expect(isRealCivilDate('2026-10-29T00:00:00Z')).toBe(false);
    });
  });

  describe('reexport do "hoje" no fuso (dono: operationDate.ts)', () => {
    const instant = new Date('2026-10-29T23:30:00Z'); // 20:30 em Buenos Aires
    it('operationDateOf(AR): 23:30Z e 02:30Z do dia seguinte são ambos 29 em BA', () => {
      expect(operationDateOf('AR', instant)).toBe('2026-10-29');
      expect(operationDateOf('AR', new Date('2026-10-30T02:30:00Z'))).toBe('2026-10-29');
    });
    it('operationDateInZone', () => {
      expect(operationDateInZone('America/Argentina/Buenos_Aires', new Date('2026-10-30T02:30:00Z'))).toBe('2026-10-29');
    });
  });
});
