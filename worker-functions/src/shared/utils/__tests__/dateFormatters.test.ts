import { formatDateUTC, formatTimeUTC } from '../dateFormatters';

describe('dateFormatters', () => {
  describe('formatDateUTC', () => {
    it('formata ISO datetime para dd/MM', () => {
      expect(formatDateUTC('2026-04-10T14:00:00.000Z')).toBe('10/04');
    });

    it('formata Date object para dd/MM', () => {
      expect(formatDateUTC(new Date('2026-01-05T09:30:00.000Z'))).toBe('05/01');
    });

    it('zero-pads dia e mês', () => {
      expect(formatDateUTC('2026-03-02T00:00:00.000Z')).toBe('02/03');
    });
  });

  describe('formatTimeUTC', () => {
    it('formata ISO datetime para HH:mm', () => {
      expect(formatTimeUTC('2026-04-10T14:30:00.000Z')).toBe('14:30');
    });

    it('formata Date object para HH:mm', () => {
      expect(formatTimeUTC(new Date('2026-01-05T09:05:00.000Z'))).toBe('09:05');
    });

    it('zero-pads hora e minuto', () => {
      expect(formatTimeUTC('2026-03-02T08:03:00.000Z')).toBe('08:03');
    });
  });
});

describe('formatDateInTimezone / formatTimeInTimezone', () => {
  const { formatDateInTimezone, formatTimeInTimezone } = require('../dateFormatters');
  it('11:30Z é 08:30 do mesmo dia em Buenos Aires (default)', () => {
    expect(formatDateInTimezone('2027-04-05T11:30:00Z')).toBe('05/04');
    expect(formatTimeInTimezone('2027-04-05T11:30:00Z')).toBe('08:30');
  });
  it('00:30Z é 21:30 do dia ANTERIOR em Buenos Aires', () => {
    expect(formatDateInTimezone('2027-04-06T00:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('05/04');
    expect(formatTimeInTimezone('2027-04-06T00:30:00Z', null)).toBe('21:30');
  });
  it('fuso explícito com horário de verão (Nova York, julho = -4)', () => {
    expect(formatTimeInTimezone('2027-07-01T13:00:00Z', 'America/New_York')).toBe('09:00');
    expect(formatTimeInTimezone('2027-07-01T13:00:00Z', '')).toBe('10:00');
  });
});
