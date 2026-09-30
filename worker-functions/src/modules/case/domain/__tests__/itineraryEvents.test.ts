/**
 * itineraryEvents.test — a expansão pura de faixa × datas (D445.3). Roda com `TZ` variado
 * (`beforeAll`/`afterAll` trocando `process.env.TZ`) porque `expandItineraryEvents` só pode
 * confiar em `Date.UTC` — um teste que passa só por coincidência de fuso (São Paulo/Buenos Aires
 * = -03) é o que a memória `teste-de-fuso-passa-por-coincidencia` pede para nunca escrever de
 * novo. `describe.each` roda a MESMA suíte sob 'UTC' e 'Asia/Tokyo'.
 */
import {
  expandItineraryEvents,
  weekdayOfDateString,
  addDaysToDateString,
  dayCountInclusive,
  type ItineraryEventAssignmentRow,
  type ItineraryEventAbsenceRow,
} from '../itineraryEvents';

const ORIGINAL_TZ = process.env.TZ;

function assignment(overrides: Partial<ItineraryEventAssignmentRow> = {}): ItineraryEventAssignmentRow {
  return {
    assignmentId: 'a-1',
    slotId: 'slot-1',
    serviceId: 'svc-1',
    weekday: 0, // domingo
    startTime: '09:00',
    endTime: '13:00',
    workerId: 'w-titular',
    validFrom: '2026-09-01',
    validTo: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

describe.each(['UTC', 'Asia/Tokyo'])('itineraryEvents (TZ=%s)', (tz) => {
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it('weekdayOfDateString: 2026-09-27 é domingo (0), 2026-09-28 é segunda (1)', () => {
    expect(weekdayOfDateString('2026-09-27')).toBe(0);
    expect(weekdayOfDateString('2026-09-28')).toBe(1);
  });

  it('addDaysToDateString: soma e subtrai, inclusive virada de mês/ano', () => {
    expect(addDaysToDateString('2026-09-27', 1)).toBe('2026-09-28');
    expect(addDaysToDateString('2026-09-27', -1)).toBe('2026-09-26');
    expect(addDaysToDateString('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysToDateString('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('dayCountInclusive: mesma data = 1; 7 dias = 8 datas', () => {
    expect(dayCountInclusive('2026-09-27', '2026-09-27')).toBe(1);
    expect(dayCountInclusive('2026-09-27', '2026-10-04')).toBe(8);
  });

  it('gera um evento coberto por data em que o slot (domingo) cai no intervalo', () => {
    const events = expandItineraryEvents([assignment()], [], '2026-09-27', '2026-10-04');
    // 2026-09-27 (dom) e 2026-10-04 (dom) — só esses dois domingos no intervalo de 8 dias.
    expect(events.map((e) => e.date)).toEqual(['2026-09-27', '2026-10-04']);
    expect(events[0].status).toBe('covered');
    expect(events[0].workerId).toBe('w-titular');
  });

  it('ausência SEM substituto vira uncovered (workerId null, mesmo alerta do Kanban)', () => {
    const absences: ItineraryEventAbsenceRow[] = [
      { absenceId: 'ab-1', assignmentId: 'a-1', onDate: '2026-09-27', substituteWorkerId: null },
    ];
    const events = expandItineraryEvents([assignment()], absences, '2026-09-27', '2026-09-27');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('uncovered');
    expect(events[0].workerId).toBeNull();
    expect(events[0].absenceId).toBe('ab-1');
  });

  it('ausência COM substituto vira substituted (workerId = substituto)', () => {
    const absences: ItineraryEventAbsenceRow[] = [
      { absenceId: 'ab-2', assignmentId: 'a-1', onDate: '2026-09-27', substituteWorkerId: 'w-sub' },
    ];
    const events = expandItineraryEvents([assignment()], absences, '2026-09-27', '2026-09-27');
    expect(events[0].status).toBe('substituted');
    expect(events[0].workerId).toBe('w-sub');
    expect(events[0].substituteWorkerId).toBe('w-sub');
  });

  it('fora da vigência (validTo < data) não gera evento', () => {
    const events = expandItineraryEvents(
      [assignment({ validTo: '2026-09-20' })],
      [],
      '2026-09-27',
      '2026-09-27',
    );
    expect(events).toHaveLength(0);
  });

  it('alocação ENDED não gera evento mesmo dentro do intervalo de validFrom/validTo', () => {
    const events = expandItineraryEvents(
      [assignment({ status: 'ENDED', validTo: '2026-12-31' })],
      [],
      '2026-09-27',
      '2026-09-27',
    );
    expect(events).toHaveLength(0);
  });

  it('filtro por serviceId exclui eventos de outros serviços', () => {
    const events = expandItineraryEvents(
      [assignment({ serviceId: 'svc-1' }), assignment({ assignmentId: 'a-2', slotId: 'slot-2', serviceId: 'svc-2' })],
      [],
      '2026-09-27',
      '2026-09-27',
      { serviceId: 'svc-2' },
    );
    expect(events).toHaveLength(1);
    expect(events[0].serviceId).toBe('svc-2');
  });

  it('filtro por workerId casa titular OU quem cobre de fato (substituto)', () => {
    const absences: ItineraryEventAbsenceRow[] = [
      { absenceId: 'ab-3', assignmentId: 'a-1', onDate: '2026-09-27', substituteWorkerId: 'w-sub' },
    ];
    const byTitular = expandItineraryEvents([assignment()], absences, '2026-09-27', '2026-09-27', { workerId: 'w-titular' });
    const bySub = expandItineraryEvents([assignment()], absences, '2026-09-27', '2026-09-27', { workerId: 'w-sub' });
    const byOther = expandItineraryEvents([assignment()], absences, '2026-09-27', '2026-09-27', { workerId: 'w-outro' });
    expect(byTitular).toHaveLength(1);
    expect(bySub).toHaveLength(1);
    expect(byOther).toHaveLength(0);
  });

  it('ordena por data e depois por horário de início', () => {
    const early = assignment({ assignmentId: 'a-early', slotId: 'slot-early', startTime: '07:00', endTime: '08:00' });
    const late = assignment({ assignmentId: 'a-late', slotId: 'slot-late', startTime: '18:00', endTime: '19:00' });
    const events = expandItineraryEvents([late, early], [], '2026-09-27', '2026-09-27');
    expect(events.map((e) => e.startTime)).toEqual(['07:00', '18:00']);
  });

  it('reemplazo permanente (D445.5): titular ACTIVE com valid_to=D-1 trabalha até D-1 e o novo entra em D — nenhuma data fica descoberta', () => {
    const titular = assignment({ assignmentId: 'a-tit', workerId: 'w-titular', validTo: '2026-10-03' });
    const novo = assignment({ assignmentId: 'a-novo', workerId: 'w-novo', validFrom: '2026-10-04' });
    const events = expandItineraryEvents([titular, novo], [], '2026-09-27', '2026-10-11');
    expect(events.map((e) => [e.date, e.workerId])).toEqual([
      ['2026-09-27', 'w-titular'],
      ['2026-10-04', 'w-novo'],
      ['2026-10-11', 'w-novo'],
    ]);
  });

  it('contraste: o mesmo titular gravado como ENDED (o defeito anterior) some de TODAS as datas, inclusive as anteriores a D', () => {
    const titular = assignment({ assignmentId: 'a-tit', workerId: 'w-titular', validTo: '2026-10-03', status: 'ENDED' });
    const events = expandItineraryEvents([titular], [], '2026-09-27', '2026-10-03');
    expect(events).toHaveLength(0);
  });
});
