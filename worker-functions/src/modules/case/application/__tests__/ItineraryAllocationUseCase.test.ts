/**
 * ItineraryAllocationUseCase — Fase 11, DX-11.6/DX-11.7. `reader`, `writer` e a TRANSAÇÃO
 * (`runInTransaction`) injetados — sem banco real (molde `ServiceTeamMarkUseCase.test.ts`). A
 * transação injetada só chama `fn` direto no client dublê, provando que a ORDEM (slot → endereço →
 * ativo → leitor do time → gate → candidatura → escrita) é do caso de uso, não da infraestrutura.
 */
import {
  ItineraryAllocationUseCase,
  NotSelectedForServiceError,
  AlreadyAllocatedInSlotError,
  AllocationNotFoundError,
  AllocationNotActiveError,
  ReplacementDateInPastError,
  type ItineraryAllocationReaderPort,
  type ItineraryAllocationWriterPort,
} from '../ItineraryAllocationUseCase';
import { ServiceWithoutAddressError, SlotInactiveError, SlotNotFoundError } from '../ItinerarySlotWriteUseCase';
import { ItineraryOverlapError } from '../../domain/itineraryOverlap';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

/** O 3º parâmetro do construtor (`runInTransaction`) é genérico — jest.fn() não tipa genéricos, daí o cast local. */
type RunInTransaction = ConstructorParameters<typeof ItineraryAllocationUseCase>[2];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

function writerStub(overrides: Partial<ItineraryAllocationWriterPort> = {}): ItineraryAllocationWriterPort {
  return {
    findSlotForAllocation: jest.fn(),
    findApplicationId: jest.fn(),
    insertAllocation: jest.fn(),
    findAllocation: jest.fn(),
    endAllocation: jest.fn(),
    scheduleAllocationEnd: jest.fn(),
    ...overrides,
  };
}

const SELECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [
    { workerId: 'w-1', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
  ],
  assignments: [],
  marks: [],
};

const NOT_SELECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [],
  assignments: [],
  marks: [],
};

const ACTIVE_SLOT = { slotId: 'slot-1', active: true, addressId: 'addr-1' };

/** Dublê da derivação do estado (cadeia Fase 15, DX-15.15): os casos da Fase 11 não medem a derivação. */
const semDerivacao = { run: jest.fn(async () => 'unchanged' as const) };

function pgError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('db error'), { code, ...extra });
}

describe('ItineraryAllocationUseCase.allocate', () => {
  it('slot null → SlotNotFoundError (404); 0 leitura do time', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findSlotForAllocation: jest.fn().mockResolvedValue(null) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(SlotNotFoundError);

    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.insertAllocation).not.toHaveBeenCalled();
  });

  it('sem endereço → ServiceWithoutAddressError (422), ANTES do leitor', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue({ slotId: 'slot-1', active: true, addressId: null }),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(ServiceWithoutAddressError);

    expect(reader.readWith).not.toHaveBeenCalled();
  });

  it('slot inativo → SlotInactiveError (422), ANTES do leitor', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue({ slotId: 'slot-1', active: false, addressId: 'addr-1' }),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(SlotInactiveError);

    expect(reader.readWith).not.toHaveBeenCalled();
  });

  it('serviço/paciente some entre o slot e o leitor → SlotNotFoundError (defensivo)', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(null) };
    const writer = writerStub({ findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(SlotNotFoundError);
  });

  it('não elegível (fora de Selecionado e de Em Atendimento+candidato) → NotSelectedForServiceError; 0 insert', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(NOT_SELECTED_ROW) };
    const writer = writerStub({ findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(writer.insertAllocation).not.toHaveBeenCalled();
  });

  it('elegível mas sem candidatura (findApplicationId null) → NotSelectedForServiceError', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
      findApplicationId: jest.fn().mockResolvedValue(null),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(writer.insertAllocation).not.toHaveBeenCalled();
  });

  it('sem vaga viva (liveVacancyId null) → NotSelectedForServiceError, sem chamar findApplicationId', async () => {
    const row: ServiceTeamRows = { ...SELECTED_ROW, liveVacancyId: null };
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(row) };
    const writer = writerStub({ findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(writer.findApplicationId).not.toHaveBeenCalled();
  });

  it('23P01 do escritor → ItineraryOverlapError decodificado do DETAIL', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const detail = JSON.stringify({
      existingServiceId: 's-old',
      existingWeekday: 1,
      existingStart: '08:00',
      existingEnd: '12:00',
      requestedServiceId: 's-1',
      requestedWeekday: 1,
      requestedStart: '11:30',
      requestedEnd: '15:00',
      sameAddress: true,
      minGapMinutes: null,
    });
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockRejectedValue(pgError('23P01', { message: 'itinerary_overlap', detail })),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    const err = await useCase
      .allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ItineraryOverlapError);
    expect((err as InstanceType<typeof ItineraryOverlapError>).existing.serviceId).toBe('s-old');
    expect((err as InstanceType<typeof ItineraryOverlapError>).minGapMinutes).toBeNull();
  });

  it('23505 uq_pia_open_pair → AlreadyAllocatedInSlotError (422)', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockRejectedValue(pgError('23505', { constraint: 'uq_pia_open_pair' })),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' }),
    ).rejects.toThrow(AlreadyAllocatedInSlotError);
  });

  it('outro 23505 (constraint diferente) → relança o erro original', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const original = pgError('23505', { constraint: 'some_other_constraint' });
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockRejectedValue(original),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    const err = await useCase
      .allocate({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' })
      .catch((e) => e);

    expect(err).toBe(original);
  });

  it('feliz: validFrom = operationDateOf(AR, now) e applicationId do escritor; leitor e escritor no MESMO client', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', validFrom: '2026-09-28' }),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);
    // meio-dia em Buenos Aires (America/Argentina/Buenos_Aires, UTC-3) — sem ambiguidade de fuso.
    const now = new Date('2026-09-28T15:00:00Z');

    const result = await useCase.allocate({
      patientId: 'p-1',
      serviceId: 's-1',
      slotId: 'slot-1',
      workerId: 'w-1',
      actorUid: 'u-1',
      now,
    });

    expect(result).toEqual({
      allocationId: 'alloc-1',
      slotId: 'slot-1',
      workerId: 'w-1',
      applicationId: 'wja-1',
      validFrom: '2026-09-28',
      status: 'ACTIVE',
    });
    const insertCall = (writer.insertAllocation as jest.Mock).mock.calls[0];
    expect(insertCall[0]).toBe(FAKE_CLIENT);
    expect(insertCall[1].validFrom).toBe('2026-09-28');
    expect((reader.readWith as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
  });
});

describe('ItineraryAllocationUseCase.end', () => {
  it('alocação inexistente → AllocationNotFoundError (404)', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAllocation: jest.fn().mockResolvedValue(null) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.end({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotFoundError);

    expect(writer.endAllocation).not.toHaveBeenCalled();
  });

  it('alocação já ENDED → AllocationNotActiveError (422), sem chamar endAllocation', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ENDED', validFrom: '2026-01-01' }),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.end({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotActiveError);

    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.endAllocation).not.toHaveBeenCalled();
  });

  it('feliz: encerra com hoje = operationDateOf(country, now); leitor e escritor no MESMO client', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ACTIVE', validFrom: '2026-09-01' }),
      endAllocation: jest.fn().mockResolvedValue(1),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);
    const now = new Date('2026-09-28T15:00:00Z');

    const result = await useCase.end({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1', now });

    expect(result).toEqual({ allocationId: 'alloc-1', status: 'ENDED', validTo: '2026-09-28' });
    const endCall = (writer.endAllocation as jest.Mock).mock.calls[0];
    expect(endCall[0]).toBe(FAKE_CLIENT);
    expect(endCall).toEqual([FAKE_CLIENT, 'alloc-1', '2026-09-28', 'u-1']);
    expect((reader.readWith as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
  });

  it('rowCount 0 no endAllocation (corrida) → AllocationNotActiveError', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ACTIVE', validFrom: '2026-09-01' }),
      endAllocation: jest.fn().mockResolvedValue(0),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.end({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotActiveError);
  });

  it('serviço/paciente some entre o findAllocation e o leitor → AllocationNotFoundError (defensivo)', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(null) };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ACTIVE', validFrom: '2026-09-01' }),
    });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(
      useCase.end({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotFoundError);

    expect(writer.endAllocation).not.toHaveBeenCalled();
  });
});

describe('ItineraryAllocationUseCase — a derivação do estado do paciente (cadeia Fase 15)', () => {
  const ALLOC_INPUT = { patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', workerId: 'w-1', actorUid: 'u-1' };
  const END_INPUT = { patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', actorUid: 'u-1' };
  const derivacao = () => ({ run: jest.fn(async () => 'moved' as const) });
  const writerFeliz = (overrides: Partial<ItineraryAllocationWriterPort> = {}) => writerStub({
    findSlotForAllocation: jest.fn().mockResolvedValue(ACTIVE_SLOT),
    findApplicationId: jest.fn().mockResolvedValue('wja-1'),
    insertAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', validFrom: '2026-09-28' }),
    findAllocation: jest.fn().mockResolvedValue({ id: 'alloc-1', status: 'ACTIVE', validFrom: '2026-09-01' }),
    endAllocation: jest.fn().mockResolvedValue(1),
    ...overrides,
  });

  it('allocate: deriva 1× com o MESMO client do runInTransaction, o patientId e o now — DEPOIS do insertAllocation', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerFeliz();
    const derivation = derivacao();
    const now = new Date('2026-09-28T15:00:00Z');
    await new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), derivation).allocate({ ...ALLOC_INPUT, now });

    expect(derivation.run).toHaveBeenCalledTimes(1);
    const [client, patientId, quando] = derivation.run.mock.calls[0] as unknown as [unknown, string, Date];
    expect(client).toBe(FAKE_CLIENT);
    expect(patientId).toBe('p-1');
    expect(quando).toBe(now);
    expect((writer.insertAllocation as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(derivation.run.mock.invocationCallOrder[0]);
  });

  it('allocate: insert falha (23P01 / 23505 do par aberto) → a derivação não roda', async () => {
    for (const erro of [pgError('23P01', { message: 'itinerary_overlap', detail: '{}' }), pgError('23505', { constraint: 'uq_pia_open_pair' })]) {
      const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
      const derivation = derivacao();
      const writer = writerFeliz({ insertAllocation: jest.fn().mockRejectedValue(erro) });
      await expect(new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), derivation).allocate(ALLOC_INPUT)).rejects.toBeDefined();
      expect(derivation.run).not.toHaveBeenCalled();
    }
  });

  it('allocate: erro de banco DA derivação sai CRU (não vira AlreadyAllocatedInSlotError) — ela está fora do try do insert', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const original = pgError('23505', { constraint: 'uq_pia_open_pair' });
    const derivation = { run: jest.fn(async () => { throw original; }) };
    const err = await new ItineraryAllocationUseCase(reader, writerFeliz(), runInTransactionStub(), derivation)
      .allocate(ALLOC_INPUT)
      .catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(AlreadyAllocatedInSlotError);
  });

  it('end: deriva 1× com o MESMO client, o patientId e o now — DEPOIS do endAllocation', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerFeliz();
    const derivation = derivacao();
    const now = new Date('2026-09-28T15:00:00Z');
    await new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), derivation).end({ ...END_INPUT, now });

    expect(derivation.run).toHaveBeenCalledTimes(1);
    expect(derivation.run.mock.calls[0]).toEqual([FAKE_CLIENT, 'p-1', now]);
    expect((derivation.run.mock.calls[0] as unknown[])[0]).toBe(FAKE_CLIENT);
    expect((writer.endAllocation as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(derivation.run.mock.invocationCallOrder[0]);
  });

  it('end: rowCount 0 (corrida) → a derivação não roda', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const derivation = derivacao();
    const writer = writerFeliz({ endAllocation: jest.fn().mockResolvedValue(0) });
    await expect(new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), derivation).end(END_INPUT)).rejects.toThrow(AllocationNotActiveError);
    expect(derivation.run).not.toHaveBeenCalled();
  });
});

describe('ItineraryAllocationUseCase.replace (D445.5 — reemplazo permanente)', () => {
  const REPLACE_INPUT = { patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', newWorkerId: 'w-1', fromDate: '2026-09-30', actorUid: 'u-1' };
  const ACTIVE_ALLOCATION_WITH_SLOT = { id: 'alloc-1', status: 'ACTIVE' as const, validFrom: '2026-09-01', slotId: 'slot-1' };

  it('alocação inexistente → AllocationNotFoundError, sem tocar o leitor do time', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAllocation: jest.fn().mockResolvedValue(null) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(useCase.replace(REPLACE_INPUT)).rejects.toThrow(AllocationNotFoundError);
    expect(reader.readWith).not.toHaveBeenCalled();
  });

  it('alocação não ACTIVE → AllocationNotActiveError', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAllocation: jest.fn().mockResolvedValue({ ...ACTIVE_ALLOCATION_WITH_SLOT, status: 'ENDED' as const }) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(useCase.replace(REPLACE_INPUT)).rejects.toThrow(AllocationNotActiveError);
  });

  it('fromDate no passado (antes de operationDateOf) → ReplacementDateInPastError, sem chamar endAllocation', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION_WITH_SLOT) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);
    const now = new Date('2026-10-15T15:00:00Z'); // depois do fromDate pedido (2026-09-30)

    await expect(useCase.replace({ ...REPLACE_INPUT, now })).rejects.toThrow(ReplacementDateInPastError);
    expect(writer.scheduleAllocationEnd).not.toHaveBeenCalled();
  });

  it('novo prestador fora de Selecionado (C) → NotSelectedForServiceError, sem encerrar o titular', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(NOT_SELECTED_ROW) };
    const writer = writerStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION_WITH_SLOT) });
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), semDerivacao);

    await expect(useCase.replace(REPLACE_INPUT)).rejects.toThrow(NotSelectedForServiceError);
    expect(writer.scheduleAllocationEnd).not.toHaveBeenCalled();
  });

  it('feliz: encerra o titular em D-1 e cria o novo a partir de D, no MESMO slot, 1 só transação', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION_WITH_SLOT),
      scheduleAllocationEnd: jest.fn().mockResolvedValue(1),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockResolvedValue({ id: 'alloc-2', validFrom: '2026-09-30' }),
    });
    const runInTransaction = runInTransactionStub();
    const derivation = { run: jest.fn(async () => 'moved' as const) };
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransaction, derivation);
    const now = new Date('2026-09-25T12:00:00Z');

    const result = await useCase.replace({ ...REPLACE_INPUT, now });

    expect(runInTransaction).toHaveBeenCalledTimes(1); // 1 SÓ transação — a régua do teste feliz
    expect(writer.scheduleAllocationEnd).toHaveBeenCalledWith(FAKE_CLIENT, 'alloc-1', '2026-09-29', 'u-1'); // D-1 de 2026-09-30
    // O titular NÃO é `ENDED`: `endAllocation` grava `status='ENDED'` e as leituras de vigência só contam `ACTIVE` —
    // o titular sairia HOJE, antes de D. Ele fica `ACTIVE` com `valid_to = D-1`.
    expect(writer.endAllocation).not.toHaveBeenCalled();
    expect(writer.insertAllocation).toHaveBeenCalledWith(FAKE_CLIENT, {
      slotId: 'slot-1',
      workerId: 'w-1',
      applicationId: 'wja-1',
      validFrom: '2026-09-30',
      actorUid: 'u-1',
    });
    expect(result).toEqual({
      endedAllocationId: 'alloc-1',
      endedValidTo: '2026-09-29',
      newAllocationId: 'alloc-2',
      newWorkerId: 'w-1',
      validFrom: '2026-09-30',
      status: 'ACTIVE',
    });
    expect(derivation.run).toHaveBeenCalledTimes(1);
    // end ANTES de insert ANTES da derivação — a ordem da 1 transação.
    expect((writer.scheduleAllocationEnd as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (writer.insertAllocation as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((writer.insertAllocation as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(derivation.run.mock.invocationCallOrder[0]);
  });

  it('conflito no insert (409 sobreposição) → propaga ITINERARY_OVERLAP; a mesma transação (o teste prova que endAllocation FOI chamado antes — quem garante o rollback é withActorContext, fora do escopo deste unit)', async () => {
    const reader: ItineraryAllocationReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION_WITH_SLOT),
      scheduleAllocationEnd: jest.fn().mockResolvedValue(1),
      findApplicationId: jest.fn().mockResolvedValue('wja-1'),
      insertAllocation: jest.fn().mockRejectedValue(pgError('23P01', { message: 'itinerary_overlap', detail: '{}' })),
    });
    const derivation = { run: jest.fn(async () => 'moved' as const) };
    const useCase = new ItineraryAllocationUseCase(reader, writer, runInTransactionStub(), derivation);

    await expect(useCase.replace(REPLACE_INPUT)).rejects.toBeDefined();
    expect(derivation.run).not.toHaveBeenCalled();
  });
});
