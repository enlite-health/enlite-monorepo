/**
 * serviceOccurrences.test — spec 069, FR-12/FR-13/FR-35. A expansão parte das FAIXAS vigentes na data; "Sin cubrir" tem um
 * dono só. Roda sob 'UTC' e 'Asia/Tokyo' (a expansão só pode usar `Date.UTC`, memória `teste-de-fuso-passa-por-coincidencia`).
 */
import { operationDateOf } from '@shared/locale/operationDate';
import {
  expandServiceOccurrences,
  uncoveredWindow,
  UNCOVERED_HORIZON_DAYS,
  type OccurrenceAbsence,
  type OccurrenceAssignment,
  type OccurrenceSlot,
} from '../serviceOccurrences';

const ORIGINAL_TZ = process.env.TZ;

function slot(o: Partial<OccurrenceSlot> = {}): OccurrenceSlot {
  return {
    slotId: 'slot-1',
    serviceId: 'svc-1',
    weekday: 0, // domingo
    startTime: '09:00',
    endTime: '13:00',
    validFrom: '2026-01-01',
    validTo: null,
    ...o,
  };
}

function assignment(o: Partial<OccurrenceAssignment> = {}): OccurrenceAssignment {
  return { assignmentId: 'a-1', slotId: 'slot-1', workerId: 'w-titular', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE', ...o };
}

function absence(o: Partial<OccurrenceAbsence> = {}): OccurrenceAbsence {
  return { absenceId: 'ab-1', assignmentId: 'a-1', onDate: '2026-09-27', substituteWorkerId: null, requestId: 'req-1', ...o };
}

describe.each(['UTC', 'Asia/Tokyo'])('expandServiceOccurrences (TZ=%s)', (tz) => {
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it('uma ocorrência coberta por data em que a faixa (domingo) cai no intervalo', () => {
    const rows = expandServiceOccurrences([slot()], [assignment()], [], '2026-09-27', '2026-10-04');
    expect(rows.map((r) => r.date)).toEqual(['2026-09-27', '2026-10-04']);
    expect(rows[0]).toMatchObject({ status: 'covered', workerId: 'w-titular', assignmentId: 'a-1', absenceId: null, requestId: null, slotId: 'slot-1' });
  });

  it('ausência SEM substituto = uncovered (workerId null), com o requestId da ausência', () => {
    const [row] = expandServiceOccurrences([slot()], [assignment()], [absence()], '2026-09-27', '2026-09-27');
    expect(row).toMatchObject({ status: 'uncovered', workerId: null, titularWorkerId: 'w-titular', absenceId: 'ab-1', requestId: 'req-1' });
  });

  it('ausência COM substituto = substituted (workerId = substituto)', () => {
    const [row] = expandServiceOccurrences([slot()], [assignment()], [absence({ substituteWorkerId: 'w-sub' })], '2026-09-27', '2026-09-27');
    expect(row).toMatchObject({ status: 'substituted', workerId: 'w-sub', substituteWorkerId: 'w-sub' });
  });

  it('FR-12: faixa SEM alocação vigente = UMA linha uncovered com ids nulos (não some da agenda)', () => {
    const rows = expandServiceOccurrences([slot()], [], [], '2026-09-27', '2026-09-27');
    expect(rows).toEqual([
      expect.objectContaining({ status: 'uncovered', assignmentId: null, titularWorkerId: null, absenceId: null, requestId: null, workerId: null, slotId: 'slot-1' }),
    ]);
  });

  it('alocação fora da vigência (validTo < data) ou ENDED não conta: a faixa vira uncovered', () => {
    const vencida = expandServiceOccurrences([slot()], [assignment({ validTo: '2026-09-20' })], [], '2026-09-27', '2026-09-27');
    const encerrada = expandServiceOccurrences([slot()], [assignment({ status: 'ENDED', validTo: '2026-12-31' })], [], '2026-09-27', '2026-09-27');
    expect(vencida[0]).toMatchObject({ status: 'uncovered', assignmentId: null });
    expect(encerrada[0]).toMatchObject({ status: 'uncovered', assignmentId: null });
  });

  it('validTo é INCLUSIVO (último dia trabalhado): no próprio validTo a alocação ainda cobre; no dia seguinte, não', () => {
    const titular = assignment({ validTo: '2026-10-04' });
    const rows = expandServiceOccurrences([slot()], [titular], [], '2026-10-04', '2026-10-11');
    expect(rows.map((r) => [r.date, r.status])).toEqual([
      ['2026-10-04', 'covered'],
      ['2026-10-11', 'uncovered'],
    ]);
  });

  it('a vigência da FAIXA vale por data: fechada antes (validTo inclusivo) não gera linha; ainda não aberta também não', () => {
    const fechada = slot({ validTo: '2026-10-03' }); // último dia vigente 03/10: exclui o domingo 04
    const futura = slot({ slotId: 'slot-2', validFrom: '2026-10-11' });
    const rows = expandServiceOccurrences([fechada, futura], [assignment()], [], '2026-09-27', '2026-10-11');
    expect(rows.map((r) => [r.slotId, r.date])).toEqual([
      ['slot-1', '2026-09-27'],
      ['slot-2', '2026-10-11'],
    ]);
  });

  it('FR-13: turno noturno (20:00 + 12 h) pertence à data de INÍCIO — a ocorrência sai no dia do início, não no seguinte', () => {
    const noturno = slot({ weekday: 5, startTime: '20:00', endTime: '08:00' }); // sexta
    const rows = expandServiceOccurrences([noturno], [assignment()], [], '2026-10-02', '2026-10-05'); // sex 02 … seg 05
    expect(rows.map((r) => r.date)).toEqual(['2026-10-02']);
  });

  it('duas alocações vigentes na mesma faixa = duas linhas; uma ausente e outra não', () => {
    const a2 = assignment({ assignmentId: 'a-2', workerId: 'w-2' });
    const rows = expandServiceOccurrences([slot()], [assignment(), a2], [absence()], '2026-09-27', '2026-09-27');
    expect(rows.map((r) => [r.assignmentId, r.status])).toEqual([
      ['a-1', 'uncovered'],
      ['a-2', 'covered'],
    ]);
  });

  it('filtro por serviceId exclui faixas de outros serviços', () => {
    const rows = expandServiceOccurrences(
      [slot(), slot({ slotId: 'slot-2', serviceId: 'svc-2' })],
      [assignment(), assignment({ assignmentId: 'a-2', slotId: 'slot-2' })],
      [],
      '2026-09-27',
      '2026-09-27',
      { serviceId: 'svc-2' },
    );
    expect(rows.map((r) => r.serviceId)).toEqual(['svc-2']);
  });

  it('filtro por workerId casa titular OU quem cobre; e faixa sem ninguém sai do filtro por pessoa', () => {
    const abs = [absence({ substituteWorkerId: 'w-sub' })];
    const byTitular = expandServiceOccurrences([slot()], [assignment()], abs, '2026-09-27', '2026-09-27', { workerId: 'w-titular' });
    const bySub = expandServiceOccurrences([slot()], [assignment()], abs, '2026-09-27', '2026-09-27', { workerId: 'w-sub' });
    const other = expandServiceOccurrences([slot()], [assignment()], abs, '2026-09-27', '2026-09-27', { workerId: 'w-outro' });
    const semAlocacao = expandServiceOccurrences([slot()], [], [], '2026-09-27', '2026-09-27', { workerId: 'w-titular' });
    expect([byTitular.length, bySub.length, other.length, semAlocacao.length]).toEqual([1, 1, 0, 0]);
  });

  it('ordena por data e depois por horário de início', () => {
    const early = slot({ slotId: 'slot-early', startTime: '07:00', endTime: '08:00' });
    const late = slot({ slotId: 'slot-late', startTime: '18:00', endTime: '19:00' });
    const rows = expandServiceOccurrences([late, early], [], [], '2026-09-27', '2026-09-27');
    expect(rows.map((r) => r.startTime)).toEqual(['07:00', '18:00']);
  });

  it('reemplazo permanente: titular com valid_to=D-1 e novo a partir de D — nenhuma data fica descoberta', () => {
    const titular = assignment({ validTo: '2026-10-03' });
    const novo = assignment({ assignmentId: 'a-novo', workerId: 'w-novo', validFrom: '2026-10-04' });
    const rows = expandServiceOccurrences([slot()], [titular, novo], [], '2026-09-27', '2026-10-11');
    expect(rows.map((r) => [r.date, r.workerId])).toEqual([
      ['2026-09-27', 'w-titular'],
      ['2026-10-04', 'w-novo'],
      ['2026-10-11', 'w-novo'],
    ]);
  });
});

describe('uncoveredWindow / horizonte', () => {
  it('o horizonte é 7 e a janela é [hoje, hoje+6]: hoje+6 entra, hoje+7 não', () => {
    expect(UNCOVERED_HORIZON_DAYS).toBe(7);
    expect(uncoveredWindow('2026-10-23')).toEqual({ from: '2026-10-23', to: '2026-10-29' });
    expect(uncoveredWindow('2026-12-28')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('fuso: o "hoje" do país vem de operationDateOf — 2026-11-03T02:30Z é 02/11 em Buenos Aires (SANIDADE: em UTC já seria 03/11)', () => {
    const instante = new Date('2026-11-03T02:30:00Z');
    expect(instante.toISOString().slice(0, 10)).toBe('2026-11-03'); // sanidade: o atalho errado daria 03/11
    const hoje = operationDateOf('AR', instante);
    expect(hoje).toBe('2026-11-02');
    expect(uncoveredWindow(hoje)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });
});
