/**
 * ReplaceWithReasonUseCase — dublês por porta; um `log` de chamadas prova a ORDEM (tx → catálogo → replaceWith(derive=false) → log → derivação)
 * e que motivo/destino inválidos saem antes de qualquer escrita.
 */
import { ReplaceWithReasonUseCase, type ReplaceWithReasonInput } from '../ReplaceWithReasonUseCase';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError, DestinationRequiredError } from '../../domain/serviceExitReason';
import type { ItineraryReplaceWithResult } from '../ItineraryAllocationUseCase';

const FAKE_CLIENT = { marker: 'fake-client' } as never;
const NOW = new Date('2026-09-30T15:00:00Z');

type RunInTransaction = ConstructorParameters<typeof ReplaceWithReasonUseCase>[4];

function build(opts: { catalogHit?: boolean; changeLogError?: Error } = {}) {
  const log: string[] = [];
  const allocations = {
    replaceWith: jest.fn(async (_c: unknown, _i: unknown, o: { derive: boolean }): Promise<ItineraryReplaceWithResult> => {
      log.push(`replace(derive=${o.derive})`);
      return {
        endedAllocationId: 'alloc-1', endedValidTo: '2026-09-29', newAllocationId: 'alloc-2', newWorkerId: 'w-2',
        validFrom: '2026-09-30', status: 'ACTIVE', outgoingWorkerId: 'w-1', today: '2026-09-30',
      };
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
  const runInTransaction = jest.fn((cb: (client: unknown) => Promise<unknown>) => {
    log.push('tx');
    return cb(FAKE_CLIENT);
  }) as unknown as RunInTransaction & jest.Mock;
  const useCase = new ReplaceWithReasonUseCase(allocations, reasonCatalog, changeLog, derivation, runInTransaction);
  return { useCase, log, allocations, reasonCatalog, changeLog, derivation, runInTransaction };
}

const INPUT: ReplaceWithReasonInput = {
  patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', newWorkerId: 'w-2', fromDate: '2026-09-30',
  reasonCategory: 'DESISTENCIA_DO_PRESTADOR', destination: 'RESERVE', actorUid: 'u-1', now: NOW,
};

describe('ReplaceWithReasonUseCase', () => {
  it('ordem das escritas: tx → catálogo → replaceWith(derive=false) → log REPLACE → derivação', async () => {
    const t = build();

    const result = await t.useCase.execute(INPUT);

    expect(t.log).toEqual(['tx', 'catalog', 'replace(derive=false)', 'log', 'derive']);
    expect(t.changeLog.insert).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({
      kind: 'REPLACE', outgoingWorkerId: 'w-1', incomingWorkerId: 'w-2', assignmentId: 'alloc-1', newAssignmentId: 'alloc-2',
      effectiveDate: '2026-09-30', destination: 'RESERVE',
    }));
    expect(result).toEqual({
      endedAllocationId: 'alloc-1', endedValidTo: '2026-09-29', newAllocationId: 'alloc-2', newWorkerId: 'w-2',
      validFrom: '2026-09-30', status: 'ACTIVE', destination: 'RESERVE',
    });
  });

  it.each([undefined, null, ''])('motivo %p → ServiceExitReasonRequiredError; nenhuma transação', async (reasonCategory) => {
    const t = build();

    await expect(t.useCase.execute({ ...INPUT, reasonCategory })).rejects.toThrow(ServiceExitReasonRequiredError);
    expect(t.runInTransaction).not.toHaveBeenCalled();
  });

  it('motivo inexistente no catálogo → ServiceExitReasonInvalidError antes de replaceWith', async () => {
    const t = build({ catalogHit: false });

    await expect(t.useCase.execute(INPUT)).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(t.allocations.replaceWith).not.toHaveBeenCalled();
  });

  it('destino ausente ou fora de RESERVE|LEAVE_SERVICE → DestinationRequiredError; nenhuma transação', async () => {
    const t = build();

    await expect(t.useCase.execute({ ...INPUT, destination: undefined })).rejects.toThrow(DestinationRequiredError);
    await expect(t.useCase.execute({ ...INPUT, destination: 'OUTRO' })).rejects.toThrow(DestinationRequiredError);
    expect(t.runInTransaction).not.toHaveBeenCalled();
  });

  it('falha injetada no log → rejeita e NÃO deriva', async () => {
    const t = build({ changeLogError: new Error('boom') });

    await expect(t.useCase.execute(INPUT)).rejects.toThrow('boom');
    expect(t.derivation.run).not.toHaveBeenCalled();
  });
});
