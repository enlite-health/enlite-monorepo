/**
 * CreateSubstitutionRequestUseCase — parte PERMANENTE ("No vuelve más", spec 069 T301-T303). Portas injetadas, sem banco: prova a
 * ORDEM (cabeçalho → FR-23 → alocações → marca → derivação por ÚLTIMO e UMA vez), o destino (P6), P5 e que nada é gravado quando uma
 * validação falha. O rollback de verdade e os efeitos nas linhas são provados no e2e (Postgres real).
 */
import { CreateSubstitutionRequestUseCase, type CreatePermanentSubstitutionInput } from '../CreateSubstitutionRequestUseCase';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  WorkerHasPendingEntryError,
  WorkerHasScheduledExitError,
} from '../substitutionRequestErrors';
import { AllocationNotActiveError } from '../ItineraryAllocationUseCase';
import { DestinationNotAvailableForScheduledError, DestinationRequiredError, ServiceExitReasonInvalidError, ServiceExitReasonRequiredError } from '../../domain/serviceExitReason';
import type { WorkerAllocation } from '../../infrastructure/ItineraryAllocationWriter';
import type { ScheduledAttendances } from '../../infrastructure/ScheduledAttendanceReader';

const CLIENT = { marker: 'client' } as never;
const NOW = new Date('2026-10-30T15:00:00Z'); // hoje AR = 2026-10-30 (sexta)

const ALLOCS: WorkerAllocation[] = [
  { id: 'a-seg', slotId: 'seg', validFrom: '2026-01-01', validTo: null },
  { id: 'a-qua', slotId: 'qua', validFrom: '2026-01-01', validTo: null },
  { id: 'a-sex', slotId: 'sex', validFrom: '2026-11-02', validTo: null }, // só começaria em D
];
const NO_SCHEDULE: ScheduledAttendances = { substitutions: [], futureEntries: [] };

function build(opts: { team?: { country: string } | null; allocs?: WorkerAllocation[]; scheduled?: ScheduledAttendances; reasons?: string[]; ownAbsences?: string[]; cancelRows?: number; endRows?: number; clearRows?: number } = {}) {
  const order: string[] = [];
  const runInTransaction = jest.fn(async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
  const team = { readWith: jest.fn(async () => (opts.team === undefined ? { country: 'AR' } : opts.team)) } as never;
  const reasons = { findActiveByCode: jest.fn(async (_c: unknown, code: string) => ((opts.reasons ?? ['OTHER']).includes(code) ? { code, label: code } : null)) };
  const changeLog = { insert: jest.fn(async (_c: unknown, i: { kind: string }) => (order.push(`log:${i.kind}`), { id: 'log' })) };
  const requests = { insert: jest.fn(async () => (order.push('header'), { id: 'req-1' })) };
  const exit = {
    allocations: {
      replaceWith: jest.fn(async (_c: unknown, i: { allocationId: string }) => {
        order.push(`replace:${i.allocationId}`);
        return { endedAllocationId: i.allocationId, endedValidTo: '2026-11-01', newAllocationId: `new-${i.allocationId}`, newWorkerId: 'w-in', validFrom: '2026-11-02', status: 'ACTIVE' as const, outgoingWorkerId: 'w-out', today: '2026-10-30' };
      }),
    },
    schedule: {
      lockWorkerAllocations: jest.fn(async () => undefined),
      listWorkerAllocations: jest.fn(async () => opts.allocs ?? ALLOCS),
      scheduleAllocationEnd: jest.fn(async (_c: unknown, id: string) => (order.push(`end:${id}`), opts.endRows ?? 1)),
      cancelAllocation: jest.fn(async (_c: unknown, id: string) => (order.push(`cancel:${id}`), opts.cancelRows ?? 1)),
    },
    absenceOps: {
      listOpenOfWorker: jest.fn(async () => opts.ownAbsences ?? []),
      cancelAbsence: jest.fn(async (_c: unknown, id: string) => (order.push(`cancel-absence:${id}`), id === 'ab-gone' ? 0 : 1)),
      updateSubstitute: jest.fn(async (_c: unknown, id: string) => (order.push(`clear-sub:${id}`), id === 'ab-gone' ? 0 : 1)),
    },
    scheduled: { listFor: jest.fn(async () => opts.scheduled ?? NO_SCHEDULE) },
    marks: { rejectWith: jest.fn(async () => (order.push('reject'), undefined)) },
    derivation: { run: jest.fn(async () => (order.push('derive'), 'unchanged' as const)) },
  };
  const useCase = new CreateSubstitutionRequestUseCase(team, {} as never, {} as never, runInTransaction, reasons, changeLog, requests, {} as never, exit as never);
  return { useCase, order, requests, changeLog, exit, reasons, runInTransaction };
}

function input(o: Partial<CreatePermanentSubstitutionInput> = {}): CreatePermanentSubstitutionInput {
  return { patientId: 'p-1', serviceId: 's-1', type: 'PERMANENT', outgoingWorkerId: 'w-out', from: '2026-11-02', reasonCategory: 'OTHER', substituteWorkerId: null, actorUid: 'u-1', now: NOW, ...o };
}

describe('CreateSubstitutionRequestUseCase — PERMANENT', () => {
  it('SEM substituto (FR-30), D > hoje: fim em D-1 para quem já atende, cancela quem só começa em D; um REMOVE por alocação com o request_id e RESERVE; derivação UMA vez, por último', async () => {
    const t = build();

    const result = await t.useCase.execute(input());

    expect(t.order).toEqual(['header', 'end:a-seg', 'log:REMOVE', 'end:a-qua', 'log:REMOVE', 'cancel:a-sex', 'log:REMOVE', 'derive']);
    expect(t.exit.schedule.scheduleAllocationEnd).toHaveBeenCalledWith(CLIENT, 'a-seg', '2026-11-01', 'u-1');
    expect(t.exit.schedule.cancelAllocation).toHaveBeenCalledWith(CLIENT, 'a-sex', '2026-11-02', 'u-1');
    expect(t.changeLog.insert.mock.calls[0]).toEqual([
      CLIENT,
      expect.objectContaining({ kind: 'REMOVE', requestId: 'req-1', outgoingWorkerId: 'w-out', assignmentId: 'a-seg', effectiveDate: '2026-11-01', reasonCode: 'OTHER', destination: 'RESERVE' }),
    ]);
    expect(t.exit.allocations.replaceWith).not.toHaveBeenCalled();
    expect(t.exit.derivation.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      requestId: 'req-1', type: 'PERMANENT', from: '2026-11-02', to: null, shiftCount: 3, destination: 'RESERVE', cancelledAbsences: 0, clearedSubstitutes: 0,
      allocations: [{ allocationId: 'a-seg', newAllocationId: null }, { allocationId: 'a-qua', newAllocationId: null }, { allocationId: 'a-sex', newAllocationId: null }],
    });
    expect(t.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it('COM substituto: replaceWith(derive:false) por alocação, REPLACE com request_id/newAssignmentId/incoming; nenhum REMOVE; derivação por último', async () => {
    const t = build();

    const result = await t.useCase.execute(input({ substituteWorkerId: 'w-in' }));

    expect(t.order).toEqual(['header', 'replace:a-seg', 'log:REPLACE', 'replace:a-qua', 'log:REPLACE', 'replace:a-sex', 'log:REPLACE', 'derive']);
    expect(t.exit.allocations.replaceWith).toHaveBeenCalledWith(
      CLIENT,
      { patientId: 'p-1', serviceId: 's-1', allocationId: 'a-seg', newWorkerId: 'w-in', fromDate: '2026-11-02', actorUid: 'u-1', now: NOW },
      { derive: false },
    );
    expect(t.changeLog.insert.mock.calls[0][1]).toMatchObject({
      kind: 'REPLACE', requestId: 'req-1', outgoingWorkerId: 'w-out', incomingWorkerId: 'w-in', assignmentId: 'a-seg', newAssignmentId: 'new-a-seg', effectiveDate: '2026-11-02', destination: 'RESERVE',
    });
    expect(result.allocations[0]).toEqual({ allocationId: 'a-seg', newAllocationId: 'new-a-seg' });
    expect(t.exit.schedule.scheduleAllocationEnd).not.toHaveBeenCalled();
  });

  it('FR-23: cancela as faltas DELA com on_date ≥ D (conta só as que mudaram) e limpa o substituto onde ELA cobre com data ≥ D, com SUBSTITUTE_CANCELLED + request_id, ANTES das alocações', async () => {
    const scheduled: ScheduledAttendances = {
      substitutions: [
        { absenceId: 'ab-antes', date: '2026-11-01' }, // antes de D: fica
        { absenceId: 'ab-1', date: '2026-11-02' },
        { absenceId: 'ab-gone', date: '2026-11-03' }, // já cancelada por fora: 0 linhas, sem registro
      ],
      futureEntries: [],
    };
    const t = build({ scheduled, ownAbsences: ['ab-a', 'ab-gone', 'ab-b'] });

    const result = await t.useCase.execute(input());

    expect(t.order.slice(0, 7)).toEqual(['header', 'cancel-absence:ab-a', 'cancel-absence:ab-gone', 'cancel-absence:ab-b', 'clear-sub:ab-1', 'log:SUBSTITUTE_CANCELLED', 'clear-sub:ab-gone']);
    expect(t.order[7]).toBe('end:a-seg');
    expect(t.exit.absenceOps.updateSubstitute).not.toHaveBeenCalledWith(CLIENT, 'ab-antes', null, null, 'u-1');
    expect(t.changeLog.insert.mock.calls[0][1]).toMatchObject({ kind: 'SUBSTITUTE_CANCELLED', requestId: 'req-1', outgoingWorkerId: 'w-out', absenceId: 'ab-1', effectiveDate: '2026-11-02' });
    expect(t.changeLog.insert.mock.calls.filter(([, i]) => i.kind === 'SUBSTITUTE_CANCELLED')).toHaveLength(1);
    expect(result).toMatchObject({ cancelledAbsences: 2, clearedSubstitutes: 1 });
  });

  it('D = hoje: o destino é OBRIGATÓRIO (ausente/inválido → DestinationRequiredError, nada escrito); RESERVE não grava marca; LEAVE_SERVICE grava a marca com o MESMO motivo, antes da derivação', async () => {
    for (const destination of [undefined, null, 'ANYWHERE', 7]) {
      const t = build();
      await expect(t.useCase.execute(input({ from: '2026-10-30', destination }))).rejects.toBeInstanceOf(DestinationRequiredError);
      expect(t.requests.insert).not.toHaveBeenCalled();
    }
    const reserva = build();
    await expect(reserva.useCase.execute(input({ from: '2026-10-30', destination: 'RESERVE' }))).resolves.toMatchObject({ destination: 'RESERVE' });
    expect(reserva.exit.marks.rejectWith).not.toHaveBeenCalled();

    const sai = build();
    await sai.useCase.execute(input({ from: '2026-10-30', destination: 'LEAVE_SERVICE' }));
    expect(sai.exit.marks.rejectWith).toHaveBeenCalledWith(CLIENT, { patientId: 'p-1', serviceId: 's-1', workerId: 'w-out', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null, now: NOW });
    expect(sai.order.slice(-2)).toEqual(['reject', 'derive']);
    expect(sai.changeLog.insert.mock.calls[0][1]).toMatchObject({ kind: 'REMOVE', destination: 'LEAVE_SERVICE', effectiveDate: '2026-10-29' });
  });

  it('D > hoje: o destino do corpo é ignorado (grava RESERVE), exceto LEAVE_SERVICE que é recusado SEM escrever (P6/FR-32)', async () => {
    const t = build();
    await expect(t.useCase.execute(input({ destination: 'LEAVE_SERVICE' }))).rejects.toBeInstanceOf(DestinationNotAvailableForScheduledError);
    expect(t.requests.insert).not.toHaveBeenCalled();
    const ignora = build();
    await ignora.useCase.execute(input({ destination: 'qualquer coisa' }));
    expect(ignora.changeLog.insert.mock.calls[0][1]).toMatchObject({ destination: 'RESERVE' });
  });

  it('P5: entrada futura dela no serviço → WorkerHasPendingEntryError e NADA escrito (nem cabeçalho)', async () => {
    const t = build({ scheduled: { substitutions: [], futureEntries: [{ allocationId: 'x', validFrom: '2026-12-01', replaces: null }] } });
    await expect(t.useCase.execute(input())).rejects.toBeInstanceOf(WorkerHasPendingEntryError);
    expect(t.requests.insert).not.toHaveBeenCalled();
    expect(t.exit.derivation.run).not.toHaveBeenCalled();
  });

  it('D1: pessoa com SAÍDA AGENDADA (valid_to) numa alocação do serviço → WorkerHasScheduledExitError com o 1º dia sem ela; NADA escrito (nem cabeçalho)', async () => {
    const t = build({ allocs: [{ id: 'a-seg', slotId: 'seg', validFrom: '2026-01-01', validTo: '2026-11-14' }, { id: 'a-qua', slotId: 'qua', validFrom: '2026-01-01', validTo: '2026-11-20' }] });
    await expect(t.useCase.execute(input())).rejects.toEqual(expect.objectContaining({ name: 'WorkerHasScheduledExitError', workerId: 'w-out', exitDate: '2026-11-15' }));
    await expect(build({ allocs: [{ id: 'a-seg', slotId: 'seg', validFrom: '2026-01-01', validTo: '2026-11-14' }] }).useCase.execute(input())).rejects.toBeInstanceOf(WorkerHasScheduledExitError);
    expect(t.requests.insert).not.toHaveBeenCalled();
    expect(t.exit.schedule.scheduleAllocationEnd).not.toHaveBeenCalled();
    expect(t.exit.derivation.run).not.toHaveBeenCalled();
    // controle positivo: sem fim agendado o MESMO pedido grava
    const ok = build();
    await ok.useCase.execute(input());
    expect(ok.requests.insert).toHaveBeenCalledTimes(1);
  });

  it('D4: as alocações dela são TRAVADAS antes de lidas e antes do cabeçalho (dois "No vuelve más" concorrentes se serializam)', async () => {
    const t = build();
    await t.useCase.execute(input());
    expect(t.exit.schedule.lockWorkerAllocations).toHaveBeenCalledWith(CLIENT, 's-1', 'w-out');
    const lock = t.exit.schedule.lockWorkerAllocations.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(t.exit.schedule.listWorkerAllocations.mock.invocationCallOrder[0]);
    expect(lock).toBeLessThan(t.requests.insert.mock.invocationCallOrder[0]);
  });

  it('validações: motivo ausente/não-string ANTES de abrir transação; inativo/inexistente sem escrever; serviço 404; D no passado; pessoa sem alocação', async () => {
    for (const reasonCategory of [undefined, null, '']) {
      const t = build();
      await expect(t.useCase.execute(input({ reasonCategory }))).rejects.toBeInstanceOf(ServiceExitReasonRequiredError);
      expect(t.runInTransaction).not.toHaveBeenCalled();
    }
    const naoString = build();
    await expect(naoString.useCase.execute(input({ reasonCategory: 3 }))).rejects.toBeInstanceOf(ServiceExitReasonInvalidError);
    expect(naoString.runInTransaction).not.toHaveBeenCalled();
    const inativo = build();
    await expect(inativo.useCase.execute(input({ reasonCategory: 'NOPE' }))).rejects.toBeInstanceOf(ServiceExitReasonInvalidError);
    expect(inativo.requests.insert).not.toHaveBeenCalled();

    await expect(build({ team: null }).useCase.execute(input())).rejects.toBeInstanceOf(SubstitutionServiceNotFoundError);
    await expect(build().useCase.execute(input({ from: '2026-10-29' }))).rejects.toBeInstanceOf(SubstitutionPeriodInPastError);
    const vazio = build({ allocs: [] });
    await expect(vazio.useCase.execute(input())).rejects.toBeInstanceOf(SubstitutionNoShiftsInPeriodError);
    expect(vazio.requests.insert).not.toHaveBeenCalled();
  });

  it('alocação que já não está ACTIVE (0 linhas no fim agendado ou no cancelamento) → AllocationNotActiveError (a transação desfaz tudo); sem derivação', async () => {
    const fim = build({ endRows: 0 });
    await expect(fim.useCase.execute(input())).rejects.toBeInstanceOf(AllocationNotActiveError);
    expect(fim.exit.derivation.run).not.toHaveBeenCalled();
    const cancela = build({ allocs: [ALLOCS[2]], cancelRows: 0 });
    await expect(cancela.useCase.execute(input())).rejects.toBeInstanceOf(AllocationNotActiveError);
  });

  it('sem `now` injetado usa o relógio (data de operação do país)', async () => {
    const t = build();
    const { now: _now, ...semNow } = input({ from: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) });
    await expect(t.useCase.execute(semNow)).resolves.toMatchObject({ type: 'PERMANENT' });
  });
});
