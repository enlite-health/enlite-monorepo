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

describe('nomes dos dias em espanhol — fonte única (DAY_NAMES_ES, DAY_KEYS_ES, DAY_NAMES_ES_SHORT)', () => {
  const { DAY_NAMES_ES, DAY_KEYS_ES, DAY_NAMES_ES_SHORT } = require('../dateFormatters');
  it('índice 0 é domingo (getDay()); as 3 formas derivam da mesma lista', () => {
    expect(DAY_NAMES_ES).toEqual(['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
    expect(DAY_KEYS_ES).toEqual(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']);
    expect(DAY_NAMES_ES_SHORT).toEqual(['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']);
  });
});
