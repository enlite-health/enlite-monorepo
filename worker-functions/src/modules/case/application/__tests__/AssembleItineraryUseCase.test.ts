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

/** Dublê da derivação do estado (cadeia Fase 15, DX-15.15): os casos da Fase 11 não medem a derivação. */
const semDerivacao = { run: jest.fn(async () => 'unchanged' as const) };

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
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub(), semDerivacao);

    await expect(useCase.execute({ patientId: 'p-1', actorUid: 'u-1' })).rejects.toThrow(ItineraryPatientNotFoundError);

    expect(writer.servicesMissingSlot).not.toHaveBeenCalled();
    expect(writer.insertAssembly).not.toHaveBeenCalled();
  });

  it('0 serviço com vaga viva → NoServiceWithVacancyError; 0 insert', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 0 }),
    });
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub(), semDerivacao);

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
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub(), semDerivacao);

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
    const useCase = new AssembleItineraryUseCase(writer, runInTransactionStub(), semDerivacao);

    const result = await useCase.execute({ patientId: 'p-1', actorUid: 'staff:u-1' });

    expect(writer.insertAssembly).toHaveBeenCalledTimes(1);
    expect(writer.insertAssembly).toHaveBeenCalledWith(FAKE_CLIENT, 'p-1', 'staff:u-1');
    expect(result).toEqual({ patientId: 'p-1', assembledAt: '2026-09-28T12:00:00.000Z' });
  });
});

describe('AssembleItineraryUseCase — marcar montado deriva o estado (cadeia Fase 15)', () => {
  const derivacao = () => ({ run: jest.fn(async () => 'moved' as const) });

  it('completo: deriva 1× com o MESMO client, o patientId e o now — DEPOIS do insertAssembly', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 1 }),
      insertAssembly: jest.fn().mockResolvedValue({ id: 'asm-1', assembledAt: '2026-09-28T12:00:00.000Z' }),
    });
    const derivation = derivacao();
    const now = new Date('2026-09-28T15:00:00Z');

    const result = await new AssembleItineraryUseCase(writer, runInTransactionStub(), derivation).execute({ patientId: 'p-1', actorUid: 'u-1', now });

    expect(result).toEqual({ patientId: 'p-1', assembledAt: '2026-09-28T12:00:00.000Z' });
    expect(derivation.run).toHaveBeenCalledTimes(1);
    expect(derivation.run.mock.calls[0]).toEqual([FAKE_CLIENT, 'p-1', now]);
    expect((derivation.run.mock.calls[0] as unknown[])[0]).toBe(FAKE_CLIENT);
    expect((derivation.run.mock.calls[0] as unknown[])[2]).toBe(now);
    expect(writer.insertAssembly.mock.invocationCallOrder[0]).toBeLessThan(derivation.run.mock.invocationCallOrder[0]);
  });

  it('sem now no input: deriva com um Date (o default do caso de uso)', async () => {
    const writer = writerStub({
      patientExists: jest.fn().mockResolvedValue(true),
      servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 1 }),
      insertAssembly: jest.fn().mockResolvedValue({ id: 'asm-1', assembledAt: '2026-09-28T12:00:00.000Z' }),
    });
    const derivation = derivacao();
    await new AssembleItineraryUseCase(writer, runInTransactionStub(), derivation).execute({ patientId: 'p-1', actorUid: 'u-1' });
    expect((derivation.run.mock.calls[0] as unknown[])[2]).toBeInstanceOf(Date);
  });

  it('os 3 erros (paciente não encontrado, sem vaga viva, serviço sem slot) → a derivação não roda', async () => {
    const cenarios: Array<[Partial<ItineraryAssemblyWriterPort>, new (...a: never[]) => Error]> = [
      [{ patientExists: jest.fn().mockResolvedValue(false) }, ItineraryPatientNotFoundError],
      [{ patientExists: jest.fn().mockResolvedValue(true), servicesMissingSlot: jest.fn().mockResolvedValue({ services: [], countWithLiveVacancy: 0 }) }, NoServiceWithVacancyError],
      [{ patientExists: jest.fn().mockResolvedValue(true), servicesMissingSlot: jest.fn().mockResolvedValue({ services: [{ serviceId: 's-2', serviceCode: 'FISIO' }], countWithLiveVacancy: 2 }) }, ServiceWithoutSlotError],
    ];
    for (const [overrides, Erro] of cenarios) {
      const derivation = derivacao();
      await expect(
        new AssembleItineraryUseCase(writerStub(overrides), runInTransactionStub(), derivation).execute({ patientId: 'p-1', actorUid: 'u-1' }),
      ).rejects.toThrow(Erro);
      expect(derivation.run).not.toHaveBeenCalled();
    }
  });
});
