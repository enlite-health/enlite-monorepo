/**
 * substitutionRequest.test — spec 069: turnos da pessoa no período (FR-10/US4) e a descrição DERIVADA do pedido
 * (tipo, período, nº de turnos, Entra pela fonte única P17, "salvo", "Ajustado", Próximas × Pasadas, `undoable`).
 */
import {
  datesBetween,
  shiftsOfWorkerInPeriod,
  describeRequest,
  describeLegacyAbsence,
  type RequestAbsenceRow,
  type RequestHeaderRow,
  type RequestLogRow,
} from '../substitutionRequest';
import type { OccurrenceAssignment, OccurrenceSlot } from '../serviceOccurrences';

const HOJE = '2026-11-02'; // segunda

function slot(o: Partial<OccurrenceSlot>): OccurrenceSlot {
  return { slotId: 's', serviceId: 'svc', weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null, ...o };
}
function asg(o: Partial<OccurrenceAssignment>): OccurrenceAssignment {
  return { assignmentId: 'a', slotId: 's', workerId: 'w-out', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE', ...o };
}

describe('datesBetween', () => {
  it('inclusive nos dois extremos; invertido = vazio', () => {
    expect(datesBetween('2026-11-03', '2026-11-05')).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
    expect(datesBetween('2026-11-03', '2026-11-03')).toEqual(['2026-11-03']);
    expect(datesBetween('2026-11-05', '2026-11-03')).toEqual([]);
  });
});

describe('shiftsOfWorkerInPeriod', () => {
  // titular seg/qua/sex, 3 faixas
  const slots = [slot({ slotId: 'seg', weekday: 1 }), slot({ slotId: 'qua', weekday: 3 }), slot({ slotId: 'sex', weekday: 5, startTime: '14:00', endTime: '18:00' })];
  const assignments = [
    asg({ assignmentId: 'a-seg', slotId: 'seg' }),
    asg({ assignmentId: 'a-qua', slotId: 'qua' }),
    asg({ assignmentId: 'a-sex', slotId: 'sex' }),
    asg({ assignmentId: 'a-outro', slotId: 'seg', workerId: 'w-outro' }),
  ];

  it('US4 aceite 1: Varios días 02/11–14/11/2026 (02/11 é segunda) com titular seg/qua/sex = 6 turnos, em ordem', () => {
    const shifts = shiftsOfWorkerInPeriod(slots, assignments, 'w-out', datesBetween('2026-11-02', '2026-11-14'));
    expect(shifts.map((s) => `${s.date}/${s.slotId}`)).toEqual([
      '2026-11-02/seg', '2026-11-04/qua', '2026-11-06/sex', '2026-11-09/seg', '2026-11-11/qua', '2026-11-13/sex',
    ]);
    expect(shifts[2]).toEqual({ date: '2026-11-06', slotId: 'sex', assignmentId: 'a-sex', startTime: '14:00', endTime: '18:00' });
  });

  it('só os turnos DELA: alocação de outra pessoa na mesma faixa não entra', () => {
    const shifts = shiftsOfWorkerInPeriod(slots, assignments, 'w-outro', ['2026-11-02']);
    expect(shifts.map((s) => s.assignmentId)).toEqual(['a-outro']);
  });

  it('período sem turno da pessoa = vazio', () => {
    expect(shiftsOfWorkerInPeriod(slots, assignments, 'w-out', ['2026-11-03'])).toEqual([]); // terça
  });

  it('alocação fora da vigência na data, ENDED, ou faixa fechada na data não geram turno', () => {
    const s = shiftsOfWorkerInPeriod(
      [slot({ slotId: 'seg', validTo: '2026-11-15' })],
      [asg({ assignmentId: 'a-seg', slotId: 'seg', validTo: '2026-11-09' })],
      'w-out',
      ['2026-11-02', '2026-11-09', '2026-11-16'],
    );
    expect(s.map((x) => x.date)).toEqual(['2026-11-02', '2026-11-09']); // 16/11: alocação vencida E faixa fechada (validTo inclusivo)
    const soFaixaFechada = shiftsOfWorkerInPeriod([slot({ slotId: 'seg', validTo: '2026-11-08' })], [asg({ slotId: 'seg' })], 'w-out', ['2026-11-02', '2026-11-09']);
    expect(soFaixaFechada.map((x) => x.date)).toEqual(['2026-11-02']);
    expect(shiftsOfWorkerInPeriod(slots, [asg({ slotId: 'seg', status: 'ENDED' })], 'w-out', ['2026-11-02'])).toEqual([]);
  });

  it('dois turnos no mesmo dia saem ordenados por início', () => {
    const two = [slot({ slotId: 'tarde', startTime: '14:00', endTime: '18:00' }), slot({ slotId: 'manha' })];
    const asgs = [asg({ assignmentId: 'a1', slotId: 'tarde' }), asg({ assignmentId: 'a2', slotId: 'manha' })];
    expect(shiftsOfWorkerInPeriod(two, asgs, 'w-out', ['2026-11-02']).map((x) => x.slotId)).toEqual(['manha', 'tarde']);
  });
});

describe('describeRequest — dias', () => {
  const header: RequestHeaderRow = { id: 'r1', outgoingWorkerId: 'w-out', reasonCode: 'OTHER', createdAt: '2026-10-30T12:00:00Z', createdBy: 'u1', undoneAt: null, undoneBy: null };
  function ab(onDate: string, o: Partial<RequestAbsenceRow> = {}): RequestAbsenceRow {
    return { absenceId: `ab-${onDate}`, assignmentId: 'a', onDate, startTime: '08:00', endTime: '12:00', substituteWorkerId: 'w-sub', cancelledAt: null, assignmentStatus: 'ACTIVE', assignmentValidTo: null, ...o };
  }

  it('1 turno = ONE_DAY, sem "to", pessoa única', () => {
    const v = describeRequest(header, [ab('2026-11-03')], [], HOJE);
    expect(v).toMatchObject({ type: 'ONE_DAY', from: '2026-11-03', to: null, shiftCount: 1, when: 'upcoming', undoable: true, adjusted: false, legacy: false, requestId: 'r1' });
    expect(v.entra).toEqual({ kind: 'PERSON', workerIds: ['w-sub'], uncoveredDates: [] });
  });

  it('2 turnos no MESMO dia continuam ONE_DAY (2 turnos)', () => {
    const v = describeRequest(header, [ab('2026-11-03'), ab('2026-11-03', { absenceId: 'x', startTime: '14:00', endTime: '18:00' })], [], HOJE);
    expect(v).toMatchObject({ type: 'ONE_DAY', shiftCount: 2 });
  });

  it('6 turnos em 03/11–13/11 = DAYS, período min–max, "salvo qui 06/11: nadie" quando um turno fica sem substituto', () => {
    const abs = ['2026-11-03', '2026-11-05', '2026-11-06', '2026-11-10', '2026-11-12', '2026-11-13'].map((d) =>
      ab(d, d === '2026-11-06' ? { substituteWorkerId: null } : {}),
    );
    const v = describeRequest(header, abs, [], HOJE);
    expect(v).toMatchObject({ type: 'DAYS', from: '2026-11-03', to: '2026-11-13', shiftCount: 6 });
    expect(v.entra).toEqual({ kind: 'PARTIAL', workerIds: ['w-sub'], uncoveredDates: ['2026-11-06'] });
    expect(v.shifts).toHaveLength(6);
    expect(v.shifts[2]).toMatchObject({ date: '2026-11-06', workerId: null });
  });

  it('sem nenhum substituto = NOBODY ("Nadie todavía"); dois substitutos = MULTIPLE', () => {
    expect(describeRequest(header, [ab('2026-11-03', { substituteWorkerId: null })], [], HOJE).entra).toEqual({ kind: 'NOBODY', workerIds: [], uncoveredDates: ['2026-11-03'] });
    const multi = describeRequest(header, [ab('2026-11-03'), ab('2026-11-05', { substituteWorkerId: 'w-2' })], [], HOJE);
    expect(multi.entra).toEqual({ kind: 'MULTIPLE', workerIds: ['w-sub', 'w-2'], uncoveredDates: [] });
  });

  it('Próximas × Pasadas: algum turno >= hoje = upcoming; tudo passado = past e SEM "Deshacer"', () => {
    const past = describeRequest(header, [ab('2026-10-26'), ab('2026-10-28')], [], HOJE);
    expect(past).toMatchObject({ when: 'past', undoable: false });
    const hojeMesmo = describeRequest(header, [ab(HOJE)], [], HOJE);
    expect(hojeMesmo).toMatchObject({ when: 'upcoming', undoable: true });
  });

  it('pedido desfeito: aparece com quando/quem, conta os turnos cancelados, não é desfazível, não é "Ajustado"', () => {
    const undone = { ...header, undoneAt: '2026-10-31T10:00:00Z', undoneBy: 'u2' };
    const v = describeRequest(undone, [ab('2026-11-03', { cancelledAt: '2026-10-31T10:00:00Z' }), ab('2026-11-05', { cancelledAt: '2026-10-31T10:00:00Z' })], [], HOJE);
    expect(v).toMatchObject({ shiftCount: 2, undoneAt: '2026-10-31T10:00:00Z', undoneBy: 'u2', undoable: false, adjusted: false, type: 'DAYS' });
  });

  it('"Ajustado" (derivado): ausência cancelada fora do desfazer, ou presa em alocação encerrada; não conta a cancelada', () => {
    const cancelada = describeRequest(header, [ab('2026-11-03'), ab('2026-11-05', { cancelledAt: '2026-10-31T10:00:00Z' })], [], HOJE);
    expect(cancelada).toMatchObject({ adjusted: true, shiftCount: 1 });
    const presaStatus = describeRequest(header, [ab('2026-11-03', { assignmentStatus: 'ENDED' })], [], HOJE);
    expect(presaStatus.adjusted).toBe(true);
    const presaValidTo = describeRequest(header, [ab('2026-11-10', { assignmentValidTo: '2026-11-04' })], [], HOJE);
    expect(presaValidTo.adjusted).toBe(true);
    const ok = describeRequest(header, [ab('2026-11-03', { assignmentValidTo: '2026-11-03' })], [], HOJE);
    expect(ok.adjusted).toBe(false);
  });

  it('todas as ausências canceladas fora do desfazer: ainda descreve (usa todas) e marca "Ajustado", sem "Deshacer"', () => {
    const v = describeRequest(header, [ab('2026-11-03', { cancelledAt: '2026-10-31T10:00:00Z' })], [], HOJE);
    expect(v).toMatchObject({ shiftCount: 1, adjusted: true, undoable: false });
  });
});

describe('describeRequest — permanente (No vuelve más)', () => {
  const header: RequestHeaderRow = { id: 'r2', outgoingWorkerId: 'w-out', reasonCode: 'OTHER', createdAt: '2026-10-30T12:00:00Z', createdBy: 'u1', undoneAt: null, undoneBy: null };
  const log = (o: Partial<RequestLogRow>): RequestLogRow => ({ kind: 'REMOVE', assignmentId: 'a1', newAssignmentId: null, effectiveDate: '2026-11-19', ...o });

  it('REMOVE: "Desde" = effective_date + 1 (último dia trabalhado + 1), Entra = Nadie; 3 faixas = 3 turnos; desfazível antes de D', () => {
    const v = describeRequest(header, [], [log({ assignmentId: 'a1' }), log({ assignmentId: 'a2' }), log({ assignmentId: 'a3' })], HOJE);
    expect(v).toMatchObject({ type: 'PERMANENT', from: '2026-11-20', to: null, shiftCount: 3, undoable: true, when: 'upcoming' });
    expect(v.entra.kind).toBe('NOBODY');
  });

  it('REPLACE: "Desde" = effective_date; Entra = titular da alocação NOVA (fonte única), não o incoming do log', () => {
    const v = describeRequest(header, [], [log({ kind: 'REPLACE', effectiveDate: '2026-11-20', newAssignmentId: 'n1' })], HOJE, [
      { assignmentId: 'n1', workerId: 'w-novo', status: 'ACTIVE' },
    ]);
    expect(v).toMatchObject({ from: '2026-11-20', shiftCount: 1 });
    expect(v.entra).toEqual({ kind: 'PERSON', workerIds: ['w-novo'], uncoveredDates: [] });
  });

  it('REPLACE com a alocação nova CANCELADA (ou ausente): ninguém entra', () => {
    const rows = [log({ kind: 'REPLACE', effectiveDate: '2026-11-20', newAssignmentId: 'n1' })];
    expect(describeRequest(header, [], rows, HOJE, [{ assignmentId: 'n1', workerId: 'w-novo', status: 'CANCELLED' }]).entra.kind).toBe('NOBODY');
    expect(describeRequest(header, [], rows, HOJE).entra.kind).toBe('NOBODY');
  });

  it('REMOVE seguido de REPLACE (Elegir quién entra) na mesma alocação: UM turno, com quem entrou; "Desde" é o menor', () => {
    const rows = [log({ kind: 'REMOVE', effectiveDate: '2026-11-19' }), log({ kind: 'REPLACE', effectiveDate: '2026-11-20', newAssignmentId: 'n1' })];
    const v = describeRequest(header, [], rows, HOJE, [{ assignmentId: 'n1', workerId: 'w-novo', status: 'ACTIVE' }]);
    expect(v).toMatchObject({ shiftCount: 1, from: '2026-11-20' });
    expect(v.entra.workerIds).toEqual(['w-novo']);
  });

  it('REPLACE antes do REMOVE na lista (ordem inversa) também junta no mesmo turno e mantém quem entrou', () => {
    const rows = [log({ kind: 'REPLACE', effectiveDate: '2026-11-20', newAssignmentId: 'n1' }), log({ kind: 'REMOVE', effectiveDate: '2026-11-19' })];
    const v = describeRequest(header, [], rows, HOJE, [{ assignmentId: 'n1', workerId: 'w-novo', status: 'ACTIVE' }]);
    expect(v).toMatchObject({ shiftCount: 1, from: '2026-11-20' });
    expect(v.entra.workerIds).toEqual(['w-novo']);
  });

  it('"Desde" é SEMPRE o menor entre REMOVE (+1) e REPLACE da mesma alocação, em qualquer ordem do log', () => {
    const remove = log({ kind: 'REMOVE', effectiveDate: '2026-11-19' }); // desde 20/11
    const replaceTarde = log({ kind: 'REPLACE', effectiveDate: '2026-11-25', newAssignmentId: 'n1' });
    const novos = [{ assignmentId: 'n1', workerId: 'w-novo', status: 'ACTIVE' as const }];
    expect(describeRequest(header, [], [remove, replaceTarde], HOJE, novos).from).toBe('2026-11-20');
    expect(describeRequest(header, [], [replaceTarde, remove], HOJE, novos).from).toBe('2026-11-20');
  });

  it('depois de D vira fato (Pasadas, sem "Deshacer"); no próprio D (hoje) ainda é Próximas mas não desfazível (só ANTES de D)', () => {
    expect(describeRequest(header, [], [log({ effectiveDate: '2026-10-20' })], HOJE)).toMatchObject({ when: 'past', undoable: false });
    expect(describeRequest(header, [], [log({ effectiveDate: addOne(HOJE, -1) })], HOJE)).toMatchObject({ from: HOJE, when: 'upcoming', undoable: false });
  });

  it('desfeito: não é desfazível; só SUBSTITUTE_CANCELLED/ABSENCE no log não faz permanente', () => {
    const undone = { ...header, undoneAt: '2026-10-31T10:00:00Z', undoneBy: 'u2' };
    expect(describeRequest(undone, [], [log({ effectiveDate: '2026-11-19' })], HOJE).undoable).toBe(false);
    const onlyCancel = describeRequest(header, [], [log({ kind: 'SUBSTITUTE_CANCELLED' })], HOJE);
    expect(onlyCancel.type).toBe('ONE_DAY');
  });

  it('REPLACE/REMOVE sem assignmentId não entram (nada para contar)', () => {
    const v = describeRequest(header, [], [log({ assignmentId: null })], HOJE);
    expect(v.type).toBe('PERMANENT');
    expect(v.shiftCount).toBe(0);
  });
});

function addOne(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('describeLegacyAbsence', () => {
  it('"Sin pedido (anterior)": sem requestId, sem motivo, sem Deshacer; Próximas × Pasadas pela data', () => {
    const a: RequestAbsenceRow = { absenceId: 'ab', assignmentId: 'a', onDate: '2026-11-03', startTime: '08:00', endTime: '12:00', substituteWorkerId: null, cancelledAt: null, assignmentStatus: 'ACTIVE', assignmentValidTo: null };
    expect(describeLegacyAbsence(a, 'w-out', HOJE)).toMatchObject({ requestId: null, legacy: true, reasonCode: null, undoable: false, when: 'upcoming', shiftCount: 1, outgoingWorkerId: 'w-out' });
    expect(describeLegacyAbsence({ ...a, onDate: '2026-10-01' }, 'w-out', HOJE).when).toBe('past');
  });
});
