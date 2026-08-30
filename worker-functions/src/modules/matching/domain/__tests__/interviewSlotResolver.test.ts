import {
  formatSlotLabel,
  localParts,
  nextWeeklyOccurrences,
  resolveOfferedSlots,
  zonedLocalToInstant,
} from '../interviewSlotResolver';

const AR = 'America/Argentina/Buenos_Aires'; // UTC-3, sem horário de verão
const SP = 'America/Sao_Paulo';              // UTC-3 hoje (sem DST desde 2019)
const NY = 'America/New_York';               // com DST — prova a correção de offset

describe('localParts / zonedLocalToInstant', () => {
  it('converte local ↔ instante no fuso da Argentina (UTC-3)', () => {
    const inst = zonedLocalToInstant(2027, 4, 5, 8, 30, AR); // segunda 05/04/2027 08:30 AR
    expect(inst.toISOString()).toBe('2027-04-05T11:30:00.000Z');
    const p = localParts(inst, AR);
    expect(p).toEqual({ year: 2027, month: 4, day: 5, hour: 8, minute: 30, weekday: 1 });
  });

  it('respeita o horário de verão (Nova York: -4 em julho, -5 em janeiro)', () => {
    expect(zonedLocalToInstant(2027, 7, 1, 9, 0, NY).toISOString()).toBe('2027-07-01T13:00:00.000Z');
    expect(zonedLocalToInstant(2027, 1, 4, 9, 0, NY).toISOString()).toBe('2027-01-04T14:00:00.000Z');
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

describe('formatSlotLabel', () => {
  it('formata no fuso da vaga, não em UTC: 11:30Z é 08:30 em Buenos Aires', () => {
    expect(formatSlotLabel(new Date('2027-04-05T11:30:00Z'), AR)).toBe('Lun 05/04 08:30');
  });
  it('21h de Buenos Aires é meia-noite UTC do dia seguinte — o rótulo fica no dia certo', () => {
    expect(formatSlotLabel(new Date('2027-04-06T00:00:00Z'), AR)).toBe('Lun 05/04 21:00');
  });
  it('default = Argentina; nomes es-AR (Mié/Sáb)', () => {
    expect(formatSlotLabel(new Date('2027-04-07T13:00:00Z'))).toBe('Mié 07/04 10:00');
    expect(formatSlotLabel(new Date('2027-04-10T13:00:00Z'), SP)).toBe('Sáb 10/04 10:00');
  });
});

describe('nextWeeklyOccurrences', () => {
  const from = new Date('2027-04-07T15:00:00Z'); // quarta 07/04/2027 12:00 AR

  it('devolve as próximas N segundas às 08:30 AR, estritamente depois de from', () => {
    const occ = nextWeeklyOccurrences(1, '08:30', AR, from, 2);
    expect(occ.map((d) => d.toISOString())).toEqual(['2027-04-12T11:30:00.000Z', '2027-04-19T11:30:00.000Z']);
  });

  it('mesmo dia da semana: hora ainda por vir entra hoje; hora já passada vai para a semana que vem', () => {
    expect(nextWeeklyOccurrences(3, '15:00', AR, from, 1)[0].toISOString()).toBe('2027-04-07T18:00:00.000Z');
    expect(nextWeeklyOccurrences(3, '09:00', AR, from, 1)[0].toISOString()).toBe('2027-04-14T12:00:00.000Z');
  });

  it('aceita TIME do Postgres com segundos e hora sem zero à esquerda', () => {
    expect(nextWeeklyOccurrences(1, '08:30:00', AR, from, 1)[0].toISOString()).toBe('2027-04-12T11:30:00.000Z');
    expect(nextWeeklyOccurrences(1, '8:30', AR, from, 1)[0].toISOString()).toBe('2027-04-12T11:30:00.000Z');
  });

  it('entrada inválida → vazio (hora malformada, dia fora de 0..6, count 0)', () => {
    expect(nextWeeklyOccurrences(1, '25:00', AR, from, 2)).toEqual([]);
    expect(nextWeeklyOccurrences(1, 'x', AR, from, 2)).toEqual([]);
    expect(nextWeeklyOccurrences(7, '08:30', AR, from, 2)).toEqual([]);
    expect(nextWeeklyOccurrences(1, '08:30', AR, from, 0)).toEqual([]);
  });

  it('atravessa a troca de horário de verão sem pular nem repetir (Nova York, março 2027)', () => {
    const before = new Date('2027-03-10T12:00:00Z'); // quarta antes da troca (14/03/2027)
    const occ = nextWeeklyOccurrences(1, '09:00', NY, before, 2);
    expect(occ.map((d) => d.toISOString())).toEqual(['2027-03-15T13:00:00.000Z', '2027-03-22T13:00:00.000Z']);
  });
});

describe('resolveOfferedSlots', () => {
  const asOf = new Date('2027-04-07T15:00:00Z'); // quarta 12:00 AR
  const base = { timezone: AR };

  it('só fixos: futuros entram, passados não, formatados no fuso', () => {
    const slots = resolveOfferedSlots({
      ...base,
      meet_link_1: 'https://meet.google.com/aaa-aaaa-aaa', meet_datetime_1: '2027-04-05T11:30:00Z', // passado
      meet_link_2: 'https://meet.google.com/bbb-bbbb-bbb', meet_datetime_2: '2027-04-12T11:30:00Z',
      meet_link_3: 'https://meet.google.com/ccc-cccc-ccc', meet_datetime_3: '2027-04-09T14:00:00Z',
    }, asOf);
    expect(slots.map((s) => [s.index, s.label, s.source])).toEqual([
      [1, 'Vie 09/04 11:00', 'fixed'],
      [2, 'Lun 12/04 08:30', 'fixed'],
    ]);
    expect(slots[0].link).toBe('https://meet.google.com/ccc-cccc-ccc');
  });

  it('só recorrente: as 2 próximas ocorrências, com a sala', () => {
    const slots = resolveOfferedSlots({ ...base, meet_recurring_weekday: 1, meet_recurring_time: '08:30:00', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr' }, asOf);
    expect(slots.map((s) => s.label)).toEqual(['Lun 12/04 08:30', 'Lun 19/04 08:30']);
    expect(slots.every((s) => s.source === 'recurring' && s.link === 'https://meet.google.com/rrr-rrrr-rrr')).toBe(true);
    expect(slots.map((s) => s.index)).toEqual([1, 2]);
  });

  it('fixos + recorrente: união ordenada, cortada em 3, reindexada', () => {
    const slots = resolveOfferedSlots({
      ...base,
      meet_link_1: 'https://meet.google.com/aaa-aaaa-aaa', meet_datetime_1: '2027-04-08T13:00:00Z', // qui 10:00
      meet_link_2: 'https://meet.google.com/bbb-bbbb-bbb', meet_datetime_2: '2027-04-30T13:00:00Z', // longe
      meet_recurring_weekday: 1, meet_recurring_time: '08:30', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr',
    }, asOf);
    expect(slots.map((s) => [s.index, s.label, s.source])).toEqual([
      [1, 'Jue 08/04 10:00', 'fixed'],
      [2, 'Lun 12/04 08:30', 'recurring'],
      [3, 'Lun 19/04 08:30', 'recurring'],
    ]);
  });

  it('fixo no MESMO instante da ocorrência conta uma vez', () => {
    const slots = resolveOfferedSlots({
      ...base,
      meet_link_1: 'https://meet.google.com/aaa-aaaa-aaa', meet_datetime_1: '2027-04-12T11:30:00Z',
      meet_recurring_weekday: 1, meet_recurring_time: '08:30', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr',
    }, asOf);
    expect(slots.map((s) => s.label)).toEqual(['Lun 12/04 08:30', 'Lun 19/04 08:30']);
  });

  it('recorrente incompleto (sem hora / sem sala) é ignorado; datetime inválido é ignorado; nada → vazio', () => {
    expect(resolveOfferedSlots({ ...base, meet_recurring_weekday: 1, meet_recurring_link: 'x' }, asOf)).toEqual([]);
    expect(resolveOfferedSlots({ ...base, meet_recurring_weekday: 1, meet_recurring_time: '08:30' }, asOf)).toEqual([]);
    expect(resolveOfferedSlots({ ...base, meet_link_1: 'x', meet_datetime_1: 'not-a-date' }, asOf)).toEqual([]);
    expect(resolveOfferedSlots({}, asOf)).toEqual([]);
  });

  it('determinístico: a mesma oferta com o mesmo asOf dias depois (o clique no botão)', () => {
    const v = { ...base, meet_recurring_weekday: 1, meet_recurring_time: '08:30', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr' };
    const a = resolveOfferedSlots(v, asOf);
    const b = resolveOfferedSlots(v, asOf);
    expect(b).toEqual(a);
    // e com asOf posterior a oferta anda
    const later = resolveOfferedSlots(v, new Date('2027-04-13T15:00:00Z'));
    expect(later[0].label).toBe('Lun 19/04 08:30');
  });

  it('timezone vazio ou ausente cai no default (Argentina); São Paulo formata na hora dele', () => {
    const v = { meet_link_1: 'https://meet.google.com/aaa-aaaa-aaa', meet_datetime_1: '2027-04-12T11:30:00Z' };
    expect(resolveOfferedSlots({ ...v, timezone: '' }, asOf)[0].label).toBe('Lun 12/04 08:30');
    expect(resolveOfferedSlots({ ...v, timezone: null }, asOf)[0].label).toBe('Lun 12/04 08:30');
    expect(resolveOfferedSlots({ ...v, timezone: SP }, asOf)[0].label).toBe('Lun 12/04 08:30');
  });
});
