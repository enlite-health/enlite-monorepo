/**
 * RemoveFromItineraryUseCase — Fase 4 (change itinerario-trocas-motivos-e-figma), D4-C6. Dublês por porta,
 * transação injetada que só chama `fn` no client dublê. Um `log` de chamadas prova a ORDEM das escritas
 * (end → registro → marca → derivação) e que motivo/destino inválidos saem antes de qualquer escrita.
 */
import { RemoveFromItineraryUseCase, type RemoveFromItineraryInput } from '../RemoveFromItineraryUseCase';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError, DestinationRequiredError, WorkerHasScheduledAttendancesError } from '../../domain/serviceExitReason';
import type { ScheduledAttendances } from '../../infrastructure/ScheduledAttendanceReader';
import { ServiceTeamWorkerAllocatedError } from '../ServiceTeamMarkUseCase';
import { AllocationNotActiveError, type ItineraryEndWithResult } from '../ItineraryAllocationUseCase';

const FAKE_CLIENT = { marker: 'fake-client' } as never;
const NOW = new Date('2026-09-30T15:00:00Z');

type RunInTransaction = ConstructorParameters<typeof RemoveFromItineraryUseCase>[5];

function build(opts: { catalogHit?: boolean; changeLogError?: Error; rejectError?: Error; scheduled?: ScheduledAttendances; clearResult?: number; cancelResult?: number } = {}) {
  const log: string[] = [];
  const allocations = {
    endWith: jest.fn(async (_c: unknown, input: { allocationId: string }, o: { derive: boolean }): Promise<ItineraryEndWithResult> => {
      log.push(`end(derive=${o.derive})`);
      return { allocationId: input.allocationId, status: 'ENDED', validTo: '2026-09-30', workerId: 'w-1' };
    }),
  };
  const marks = {
    rejectWith: jest.fn(async () => {
      log.push('reject');
      if (opts.rejectError) throw opts.rejectError;
      return {};
    }),
  };
  const reasonCatalog = {
    findActiveByCode: jest.fn(async () => {
      log.push('catalog');
      return opts.catalogHit === false ? null : { code: 'DESISTENCIA_DO_PRESTADOR', label: 'x' };
    }),
  };
  const changeLog = {
    insert: jest.fn(async () => {
      log.push('log');
      if (opts.changeLogError) throw opts.changeLogError;
      return { id: 'cl-1' };
    }),
  };
  const derivation = {
    run: jest.fn(async () => {
      log.push('derive');
      return 'moved' as const;
    }),
  };
  const scheduled = { listFor: jest.fn(async () => opts.scheduled ?? { substitutions: [], futureEntries: [] }) };
  const absences = {
    updateSubstitute: jest.fn(async () => {
      log.push('sub-clear');
      return opts.clearResult ?? 1;
    }),
  };
  const schedule = {
    cancelAllocation: jest.fn(async () => {
      log.push('entry-cancel');
      return opts.cancelResult ?? 1;
    }),
    clearScheduledEnd: jest.fn(async () => {
      log.push('end-clear');
      return 1;
    }),
  };
  const runInTransaction = jest.fn((cb: (client: unknown) => Promise<unknown>) => {
    log.push('tx');
    return cb(FAKE_CLIENT);
  }) as unknown as RunInTransaction & jest.Mock;
  const useCase = new RemoveFromItineraryUseCase(allocations, marks, reasonCatalog, changeLog, derivation, runInTransaction, scheduled, absences, schedule);
  return { useCase, log, schedule, absences, scheduled, allocations, marks, reasonCatalog, changeLog, derivation, runInTransaction };
}

const INPUT: RemoveFromItineraryInput = {
  patientId: 'p-1',
  serviceId: 's-1',
  allocationId: 'alloc-1',
  reasonCategory: 'DESISTENCIA_DO_PRESTADOR',
  destination: 'RESERVE',
  actorUid: 'u-1',
  now: NOW,
};

describe('RemoveFromItineraryUseCase', () => {
  it('RESERVE: ordem tx → catálogo → end(derive=false) → registro REMOVE → derivação; NÃO chama rejectWith', async () => {
    const t = build();
    const result = await t.useCase.execute(INPUT);

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'derive']);
    expect(t.marks.rejectWith).not.toHaveBeenCalled();
    expect(t.changeLog.insert).toHaveBeenCalledWith(FAKE_CLIENT, {
      serviceId: 's-1',
      kind: 'REMOVE',
      outgoingWorkerId: 'w-1',
      assignmentId: 'alloc-1',
      effectiveDate: '2026-09-30',
      reasonCode: 'DESISTENCIA_DO_PRESTADOR',
      destination: 'RESERVE',
      actorUid: 'u-1',
    });
    expect(t.derivation.run).toHaveBeenCalledWith(FAKE_CLIENT, 'p-1', NOW);
    expect(result).toEqual({ allocationId: 'alloc-1', status: 'ENDED', validTo: '2026-09-30', destination: 'RESERVE' });
  });

  it('LEAVE_SERVICE: end → registro → marca (mesmo código, mesmo client) → derivação por ÚLTIMO', async () => {
    const t = build();
    await t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE' });

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'reject', 'derive']);
    expect(t.marks.rejectWith).toHaveBeenCalledWith(FAKE_CLIENT, {
      patientId: 'p-1',
      serviceId: 's-1',
      workerId: 'w-1',
      reasonCategory: 'DESISTENCIA_DO_PRESTADOR',
      actorUid: 'u-1',
      cells: null,
      now: NOW,
    });
    expect(t.changeLog.insert).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({ destination: 'LEAVE_SERVICE' }));
  });

  it.each([undefined, null, ''])('motivo %p → ServiceExitReasonRequiredError; nenhuma transação, nenhuma escrita', async (reasonCategory) => {
    const t = build();
    await expect(t.useCase.execute({ ...INPUT, reasonCategory })).rejects.toThrow(ServiceExitReasonRequiredError);
    expect(t.log).toEqual([]);
  });

  it('motivo que não é string → ServiceExitReasonInvalidError antes do banco', async () => {
    const t = build();
    await expect(t.useCase.execute({ ...INPUT, reasonCategory: 7 })).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(t.log).toEqual([]);
  });

  it.each([undefined, null, '', 'ELSEWHERE', 3])('destino %p → DestinationRequiredError ANTES de qualquer escrita', async (destination) => {
    const t = build();
    await expect(t.useCase.execute({ ...INPUT, destination })).rejects.toThrow(DestinationRequiredError);
    expect(t.log).toEqual([]);
    expect(t.allocations.endWith).not.toHaveBeenCalled();
  });

  it('motivo fora do catálogo (inexistente/inativo) → ServiceExitReasonInvalidError; o end NUNCA roda', async () => {
    const t = build({ catalogHit: false });
    await expect(t.useCase.execute(INPUT)).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(t.log).toEqual(['tx', 'catalog']);
    expect(t.allocations.endWith).not.toHaveBeenCalled();
    expect(t.changeLog.insert).not.toHaveBeenCalled();
  });

  it('falha injetada no registro, depois do end → propaga, sem marca e SEM derivação (a transação desfaz o end)', async () => {
    const boom = new Error('insert failed');
    const t = build({ changeLogError: boom });
    await expect(t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE' })).rejects.toBe(boom);
    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log']);
    expect(t.marks.rejectWith).not.toHaveBeenCalled();
    expect(t.derivation.run).not.toHaveBeenCalled();
  });

  it('LEAVE_SERVICE com agendamento: rejectWith recusa (ServiceTeamWorkerAllocatedError) → propaga e a derivação NÃO roda', async () => {
    const refusal = new ServiceTeamWorkerAllocatedError('p-1', 's-1', 'w-1');
    const t = build({ rejectError: refusal });
    await expect(t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE' })).rejects.toBe(refusal);
    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'reject']);
    expect(t.derivation.run).not.toHaveBeenCalled();
  });

  it('alocação que não está ACTIVE: o erro do end propaga; nada é registrado', async () => {
    const t = build();
    t.allocations.endWith.mockRejectedValueOnce(new AllocationNotActiveError('alloc-1'));
    await expect(t.useCase.execute(INPUT)).rejects.toThrow(AllocationNotActiveError);
    expect(t.changeLog.insert).not.toHaveBeenCalled();
    expect(t.derivation.run).not.toHaveBeenCalled();
  });

  it('alocação sem prestador titular (dado inconsistente): erro cru, sem registro', async () => {
    const t = build();
    t.allocations.endWith.mockResolvedValueOnce({ allocationId: 'alloc-1', status: 'ENDED', validTo: '2026-09-30', workerId: null });
    await expect(t.useCase.execute(INPUT)).rejects.toThrow(/without titular worker/);
    expect(t.changeLog.insert).not.toHaveBeenCalled();
  });

  it('LEAVE_SERVICE com agendamento e sem cancelScheduled → WorkerHasScheduledAttendancesError com as datas; sem rejectWith, sem derivação', async () => {
    const t = build({
      scheduled: {
        substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }, { absenceId: 'ab-2', date: '2026-11-02' }],
        futureEntries: [{ allocationId: 'al-9', validFrom: '2026-10-28', replacesAllocationId: 'al-3' }],
      },
    });

    const err = await t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkerHasScheduledAttendancesError);
    expect((err as WorkerHasScheduledAttendancesError).substitutionDates).toEqual(['2026-10-26', '2026-11-02']);
    expect((err as WorkerHasScheduledAttendancesError).futureEntryFrom).toBe('2026-10-28');
    expect(t.log).not.toContain('reject');
    expect(t.log).not.toContain('derive');
  });

  it('LEAVE_SERVICE sem agendamento → segue direto (marca e derivação)', async () => {
    const t = build();

    await t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE' });

    expect(t.scheduled.listFor).toHaveBeenCalledWith(FAKE_CLIENT, 's-1', 'w-1', '2026-09-30');
    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'reject', 'derive']);
  });

  it('RESERVE com agendamento → não consulta agendamentos', async () => {
    const t = build({ scheduled: { substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }], futureEntries: [] } });

    await t.useCase.execute(INPUT);

    expect(t.scheduled.listFor).not.toHaveBeenCalled();
  });

  const DOIS_SUBSTITUTOS: ScheduledAttendances = {
    substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }, { absenceId: 'ab-2', date: '2026-11-02' }],
    futureEntries: [],
  };

  it('com cancelScheduled: tira cada substituto (null,null) e registra SUBSTITUTE_CANCELLED por data, ANTES do rejectWith', async () => {
    const t = build({ scheduled: DOIS_SUBSTITUTOS });

    await t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE', cancelScheduled: true });

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'sub-clear', 'log', 'sub-clear', 'log', 'reject', 'derive']);
    expect(t.absences.updateSubstitute).toHaveBeenCalledWith(FAKE_CLIENT, 'ab-1', null, null, 'u-1');
    const chamadas = t.changeLog.insert.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>;
    const cancelados = chamadas.map(([, i]) => i).filter((i) => i.kind === 'SUBSTITUTE_CANCELLED');
    expect(cancelados).toHaveLength(2);
    expect(cancelados[0]).toEqual({
      serviceId: 's-1', kind: 'SUBSTITUTE_CANCELLED', outgoingWorkerId: 'w-1', absenceId: 'ab-1',
      effectiveDate: '2026-10-26', reasonCode: 'DESISTENCIA_DO_PRESTADOR', actorUid: 'u-1',
    });
    expect(cancelados[0]).not.toHaveProperty('destination');
  });

  it('ausência já cancelada por fora (updateSubstitute → 0): não registra', async () => {
    const t = build({ scheduled: DOIS_SUBSTITUTOS, clearResult: 0 });

    await t.useCase.execute({ ...INPUT, destination: 'LEAVE_SERVICE', cancelScheduled: true });

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'sub-clear', 'sub-clear', 'reject', 'derive']);
  });

  const UMA_ENTRADA = (replacesAllocationId: string | null): ScheduledAttendances => ({
    substitutions: [],
    futureEntries: [{ allocationId: 'al-9', validFrom: '2026-10-28', replacesAllocationId }],
  });
  const REMOVE_TUDO = { ...INPUT, destination: 'LEAVE_SERVICE', cancelScheduled: true };

  it('ordem do cancelamento: entrada futura cancelada ANTES de soltar o fim do titular; registra ENTRY_CANCELLED', async () => {
    const t = build({ scheduled: UMA_ENTRADA('al-3') });

    await t.useCase.execute(REMOVE_TUDO);

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'entry-cancel', 'log', 'end-clear', 'reject', 'derive']);
    expect(t.schedule.cancelAllocation).toHaveBeenCalledWith(FAKE_CLIENT, 'al-9', '2026-10-01', 'u-1');
    expect(t.schedule.clearScheduledEnd).toHaveBeenCalledWith(FAKE_CLIENT, 'al-3', 'u-1');
    const chamadas = t.changeLog.insert.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>;
    const entrada = chamadas.map(([, i]) => i).find((i) => i.kind === 'ENTRY_CANCELLED');
    expect(entrada).toEqual({
      serviceId: 's-1', kind: 'ENTRY_CANCELLED', outgoingWorkerId: 'w-1', assignmentId: 'al-9',
      effectiveDate: '2026-10-28', reasonCode: 'DESISTENCIA_DO_PRESTADOR', actorUid: 'u-1',
    });
    expect(entrada).not.toHaveProperty('destination');
  });

  it('entrada sem alocação substituída (replacesAllocationId null): cancela e NÃO chama clearScheduledEnd', async () => {
    const t = build({ scheduled: UMA_ENTRADA(null) });

    await t.useCase.execute(REMOVE_TUDO);

    expect(t.schedule.cancelAllocation).toHaveBeenCalledTimes(1);
    expect(t.schedule.clearScheduledEnd).not.toHaveBeenCalled();
  });

  it('cancelAllocation → 0 (já começou/cancelada): não registra e não solta o fim', async () => {
    const t = build({ scheduled: UMA_ENTRADA('al-3'), cancelResult: 0 });

    await t.useCase.execute(REMOVE_TUDO);

    expect(t.log).toEqual(['tx', 'catalog', 'end(derive=false)', 'log', 'entry-cancel', 'reject', 'derive']);
    expect(t.schedule.clearScheduledEnd).not.toHaveBeenCalled();
  });

  it('titular vigente com outra alocação: o rejectWith continua recusando (ServiceTeamWorkerAllocatedError) e a transação rejeita', async () => {
    const refusal = new ServiceTeamWorkerAllocatedError('p-1', 's-1', 'w-1');
    const t = build({ scheduled: UMA_ENTRADA('al-3'), rejectError: refusal });

    await expect(t.useCase.execute(REMOVE_TUDO)).rejects.toBe(refusal);
    expect(t.derivation.run).not.toHaveBeenCalled();
  });
});
