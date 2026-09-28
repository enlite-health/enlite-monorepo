/**
 * AssembleItineraryUseCase — Fase 11, DX-11.8 (caso de uso). `writer` e a TRANSAÇÃO
 * (`runInTransaction`) injetados — sem banco real (molde `ServiceTeamMarkUseCase.test.ts`).
 */
import {
  AssembleItineraryUseCase,
  ItineraryPatientNotFoundError,
  NoServiceWithVacancyError,
  ServiceWithoutSlotError,
  type ItineraryAssemblyWriterPort,
} from '../AssembleItineraryUseCase';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

type RunInTransaction = ConstructorParameters<typeof AssembleItineraryUseCase>[1];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

function writerStub(overrides: Partial<ItineraryAssemblyWriterPort> = {}): ItineraryAssemblyWriterPort & {
  patientExists: jest.Mock;
  servicesMissingSlot: jest.Mock;
  insertAssembly: jest.Mock;
} {
  return {
    patientExists: jest.fn(),
    servicesMissingSlot: jest.fn(),
    insertAssembly: jest.fn(),
    ...overrides,
  } as never;
}

describe('AssembleItineraryUseCase', () => {
  it('paciente fora da RLS/inexistente → ItineraryPatientNotFoundError; 0 insert', async () => {
    const writer = writerStub({ patientExists: jest.fn().mockResolvedValue(false) });
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub());

    await expect(useCase.execute({ patientId: 'p-1', actorUid: 'u-1' })).rejects.toThrow(ItineraryPatientNotFoundError);

    expect(writer.servicesMissingSlot).not.toHaveBeenCalled();
    expect(writer.insertAssembly).not.toHaveBeenCalled();
  });

  it('0 serviço com vaga viva → NoServiceWithVacancyError; 0 insert', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 0 }),
    });
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub());

    await expect(useCase.execute({ patientId: 'p-1', actorUid: 'u-1' })).rejects.toThrow(NoServiceWithVacancyError);

    expect(writer.insertAssembly).not.toHaveBeenCalled();
  });

  it('2 serviços com vaga, slot faltando em 1 → ServiceWithoutSlotError com services = o outro (id + código); 0 insert', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({
        services: [{ serviceId: 's-2', serviceCode: 'FISIO' }],
        countWithLiveVacancy: 2,
      }),
    });
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub());

    await expect(useCase.execute({ patientId: 'p-1', actorUid: 'u-1' })).rejects.toThrow(ServiceWithoutSlotError);

    try {
      await useCase.execute({ patientId: 'p-1', actorUid: 'u-1' });
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceWithoutSlotError);
      expect((err as ServiceWithoutSlotError).services).toEqual([{ serviceId: 's-2', serviceCode: 'FISIO' }]);
    }
    expect(writer.insertAssembly).not.toHaveBeenCalled();
  });

  it('completo (todo serviço com vaga tem slot) → 1 insert, devolve {patientId, assembledAt}', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 1 }),
      insertAssembly: jest.fn().mockResolvedValue({ id: 'asm-1', assembledAt: '2026-09-28T12:00:00.000Z' }),
    });
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub());

    const result = await useCase.execute({ patientId: 'p-1', actorUid: 'staff:u-1' });

    expect(writer.insertAssembly).toHaveBeenCalledTimes(1);
    expect(writer.insertAssembly).toHaveBeenCalledWith(FAKE_CLIENT, 'p-1', 'staff:u-1');
    expect(result).toEqual({ patientId: 'p-1', assembledAt: '2026-09-28T12:00:00.000Z' });
  });
});
