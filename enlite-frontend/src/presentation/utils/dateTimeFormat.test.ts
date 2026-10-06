import { describe, it, expect } from 'vitest';
import {
  OPERATION_TIME_ZONE,
  formatInstant,
  formatCalendarDate,
  formatWallDate,
  formatClockTime,
  getInstantParts,
  todayInOperationZone,
  toOperationDateTimeLocal,
  parseOperationDateTimeLocal,
} from './dateTimeFormat';

/**
 * Rodar com fuso HOSTIL no comando — `TZ=Asia/Tokyo` e `TZ=America/Los_Angeles`. São Paulo e Buenos
 * Aires (-03 os dois) mascaram o defeito.
 */
describe('dateTimeFormat', () => {
  it('sanidade: o fuso do operador é Buenos Aires', () => {
    expect(OPERATION_TIME_ZONE).toBe('America/Argentina/Buenos_Aires');
  });

  describe('formatInstant (INSTANTE)', () => {
    const iso = '2026-10-07T22:00:00Z';
    const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } as const;

    it('mostra a hora de -03 em 24h, independente do fuso do host', () => {
      const out = formatInstant(iso, opts)!;
      expect(out).toContain('7');
      expect(out).toContain('19:00');
      expect(out).not.toMatch(/[ap]\. ?m\./i);
    });

    it('cruza a meia-noite no dia certo (02:30Z = 23:30 do dia anterior em -03)', () => {
      const out = formatInstant('2026-10-08T02:30:00Z', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })!;
      expect(out).toMatch(/^0?7\/10/);
      expect(out).toContain('23:30');
    });

    it('hour12 passado por engano não traz am/pm de volta', () => {
      const out = formatInstant(iso, { hour: '2-digit', minute: '2-digit', hour12: true })!;
      expect(out).toBe('19:00');
    });

    it('timeStyle também sai em 24h', () => {
      expect(formatInstant(iso, { dateStyle: 'short', timeStyle: 'short' })).toContain('19:00');
    });

    it('aceita Date e número, e respeita o locale', () => {
      expect(formatInstant(new Date(iso), { hour: '2-digit', minute: '2-digit' })).toBe('19:00');
      expect(formatInstant(Date.parse(iso), { hour: '2-digit', minute: '2-digit' }, 'pt-BR')).toBe('19:00');
    });

    it.each([null, undefined, '', 'lixo'])('devolve null para %p', (v) => {
      expect(formatInstant(v as string, opts)).toBeNull();
    });
  });

  describe('formatCalendarDate (SÓ-DATA)', () => {
    const opts = { day: 'numeric', month: 'short' } as const;

    it('meia-noite UTC do `pg` continua no dia 7 (não vira 6)', () => {
      expect(formatCalendarDate('2026-10-07T00:00:00.000Z', opts)).toMatch(/^7 oct/i);
    });

    it('YYYY-MM-DD cru continua no dia 7', () => {
      expect(formatCalendarDate('2026-10-07', opts)).toMatch(/^7 oct/i);
      expect(formatCalendarDate('2026-10-07', { day: '2-digit', month: '2-digit', year: 'numeric' })).toBe('07/10/2026');
    });

    it.each([null, undefined, '', 'lixo', '07/10/2026'])('devolve null para %p', (v) => {
      expect(formatCalendarDate(v as string, opts)).toBeNull();
    });
  });

  describe('formatWallDate (Date de planilha construída com relógio local)', () => {
    it('mantém o dia de calendário da Date local', () => {
      expect(formatWallDate(new Date(2026, 9, 7, 0, 0, 0), { day: '2-digit', month: '2-digit', year: 'numeric' })).toBe('07/10/2026');
    });
    it('Invalid Date → null', () => {
      expect(formatWallDate(new Date(NaN), {})).toBeNull();
    });
  });

  describe('formatClockTime (SÓ-HORA)', () => {
    it('19:00:00 → 19:00', () => expect(formatClockTime('19:00:00')).toBe('19:00'));
    it('19:00 → 19:00', () => expect(formatClockTime('19:00')).toBe('19:00'));
    it('nulo/vazio → null', () => {
      expect(formatClockTime(null)).toBeNull();
      expect(formatClockTime(undefined)).toBeNull();
      expect(formatClockTime('')).toBeNull();
    });
    it('texto estranho volta como veio', () => expect(formatClockTime('tarde')).toBe('tarde'));
  });

  describe('partes e inputs no fuso do operador', () => {
    it('getInstantParts: 2026-10-08T02:30Z = 7/10 23:30', () => {
      expect(getInstantParts('2026-10-08T02:30:00Z')).toEqual({ year: 2026, month: 10, day: 7, hour: 23, minute: 30 });
      expect(getInstantParts('lixo')).toBeNull();
    });

    it('meia-noite em -03 é hora 0, não 24', () => {
      expect(getInstantParts('2026-10-07T03:05:00Z')).toMatchObject({ hour: 0, minute: 5 });
    });

    it('todayInOperationZone: 01:00Z ainda é o dia anterior em -03', () => {
      expect(todayInOperationZone(new Date('2026-10-08T01:00:00Z'))).toBe('2026-10-07');
      expect(todayInOperationZone(new Date('2026-10-08T03:00:00Z'))).toBe('2026-10-08');
    });

    it('datetime-local faz round-trip: -03 → UTC → -03', () => {
      expect(parseOperationDateTimeLocal('2026-10-07T19:00')).toBe('2026-10-07T22:00:00.000Z');
      expect(toOperationDateTimeLocal('2026-10-07T22:00:00.000Z')).toBe('2026-10-07T19:00');
      expect(toOperationDateTimeLocal('lixo')).toBe('');
    });

    it.each(['', 'lixo', '2026-10-07', '2026-13-45T10:00'])('parseOperationDateTimeLocal(%p) → null', (v) => {
      expect(parseOperationDateTimeLocal(v)).toBeNull();
    });
  });
});
