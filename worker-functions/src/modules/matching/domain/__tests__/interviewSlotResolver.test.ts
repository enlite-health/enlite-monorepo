import { localParts } from '../interviewSlotResolver';

const AR = 'America/Argentina/Buenos_Aires'; // UTC-3, sem horário de verão
const NY = 'America/New_York';               // com DST — prova a correção de offset

describe('localParts', () => {
  it('devolve as partes locais no fuso da Argentina (UTC-3)', () => {
    const p = localParts(new Date('2027-04-05T11:30:00.000Z'), AR); // segunda 05/04/2027 08:30 AR
    expect(p).toEqual({ year: 2027, month: 4, day: 5, hour: 8, minute: 30, weekday: 1 });
  });

  it('respeita o horário de verão (Nova York: -4 em julho, -5 em janeiro)', () => {
    expect(localParts(new Date('2027-07-01T13:00:00.000Z'), NY)).toMatchObject({ hour: 9, minute: 0 });
    expect(localParts(new Date('2027-01-04T14:00:00.000Z'), NY)).toMatchObject({ hour: 9, minute: 0 });
  });

  it('Intl sem uma parte (runtime sem dados ICU) LANÇA em vez de devolver "NaN/NaN 00:00" — erro visível', () => {
    const spy = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      spy.mockReturnValue([{ type: 'year', value: '2027' }] as Intl.DateTimeFormatPart[]);
      expect(() => localParts(new Date('2027-04-05T11:30:00Z'), AR)).toThrow(/sem a parte "weekday"/);
      spy.mockReturnValue([
        { type: 'weekday', value: 'lun.' }, { type: 'year', value: '2027' }, { type: 'month', value: '04' },
        { type: 'day', value: '05' }, { type: 'hour', value: '08' }, { type: 'minute', value: '30' },
      ] as Intl.DateTimeFormatPart[]);
      expect(() => localParts(new Date('2027-04-05T11:30:00Z'), AR)).toThrow(/weekday desconhecido/);
    } finally {
      spy.mockRestore();
    }
  });

  it('meia-noite local não escorrega de dia (hourCycle h23)', () => {
    const p = localParts(new Date('2027-04-06T03:00:00Z'), AR); // 00:00 AR
    expect(p).toMatchObject({ day: 6, hour: 0, minute: 0 });
  });
});
