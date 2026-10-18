/**
 * ItinerarySlotWriteUseCase — Fase 11, DX-11.5 + spec 056 T1.7. `writer` e a TRANSAÇÃO
 * (`runInTransaction`) injetados — sem banco real (molde `ServiceTeamMarkUseCase.test.ts`). A
 * transação injetada só chama `fn` direto no client dublê. Escrever horário = fechar/abrir FAIXA
 * (vigência `valid`); nenhuma escrita em `pcs.schedule`.
 */
import {
  ItinerarySlotWriteUseCase,
  ItineraryServiceNotFoundError,
  ServiceWithoutAddressError,
  SlotAlreadyExistsError,
  SlotNotFoundError,
  SlotInactiveError,
  SlotHasActiveAllocationError,
  type ItinerarySlotWriterPort,
} from '../ItinerarySlotWriteUseCase';
import type { ServiceForWrite, ItinerarySlotLookup } from '../../infrastructure/ItinerarySlotWriter';
import { ServiceSlotOverlapError } from '../../infrastructure/ServiceSlotWriter';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

type RunInTransaction = ConstructorParameters<typeof ItinerarySlotWriteUseCase>[1];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

type WriterStub = ItinerarySlotWriterPort & {
  findServiceForWrite: jest.Mock;
  findSlot: jest.Mock;
  slotHasActiveAllocation: jest.Mock;
  readVigentSlots: jest.Mock;
  openSlot: jest.Mock;
  closeSlot: jest.Mock;
};

function writerStub(overrides: Partial<ItinerarySlotWriterPort> = {}): WriterStub {
  return {
    findServiceForWrite: jest.fn(),
    findSlot: jest.fn(),
    slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
    readVigentSlots: jest.fn().mockResolvedValue([]),
    openSlot: jest.fn().mockResolvedValue('slot-new'),
    closeSlot: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

const SERVICE_WITH_ADDRESS: ServiceForWrite = { id: 's-1', addressId: 'addr-1', country: 'AR' };
const SERVICE_WITHOUT_ADDRESS: ServiceForWrite = { id: 's-1', addressId: null, country: 'AR' };

const NEW_SLOT: ItinerarySlotLookup = { id: 'slot-new', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00', vigente: true };
const OLD_SLOT: ItinerarySlotLookup = { id: 'slot-1', weekday: 2, startTime: '08:00', durationMinutes: 120, endTime: '10:00', vigente: true };

const CREATE = { patientId: 'p-1', serviceId: 's-1', weekday: 1, startTime: '08:00', durationMinutes: 240, actorUid: 'u-1' };
const UPDATE = { patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', durationMinutes: 120, actorUid: 'u-1' };
const END = { patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', actorUid: 'u-1' };

const semEscrita = (w: WriterStub) => {
  expect(w.openSlot).not.toHaveBeenCalled();
  expect(w.closeSlot).not.toHaveBeenCalled();
};

describe('ItinerarySlotWriteUseCase', () => {
  describe('create', () => {
    it('serviço inexistente → ItineraryServiceNotFoundError; nenhuma escrita', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(null) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create(CREATE)).rejects.toThrow(ItineraryServiceNotFoundError);
      semEscrita(writer);
    });

    it('sem endereço → ServiceWithoutAddressError; nenhuma escrita', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITHOUT_ADDRESS) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create(CREATE)).rejects.toThrow(ServiceWithoutAddressError);
      semEscrita(writer);
    });

    it('chave vigente igual → SlotAlreadyExistsError; nenhuma escrita', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        readVigentSlots: jest.fn().mockResolvedValue([{ id: 'x', weekday: 1, startTime: '08:00', durationMinutes: 240 }]),
      });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create(CREATE)).rejects.toThrow(SlotAlreadyExistsError);
      semEscrita(writer);
    });

    it('mesmo início com duração diferente NÃO é a mesma chave', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        readVigentSlots: jest.fn().mockResolvedValue([{ id: 'x', weekday: 1, startTime: '08:00', durationMinutes: 300 }]),
        findSlot: jest.fn().mockResolvedValue(NEW_SLOT),
      });
      await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create(CREATE);
      expect(writer.openSlot).toHaveBeenCalledTimes(1);
    });

    it('feliz → openSlot 1× com a chave + hoje do país; devolve a faixa sem o campo interno `vigente`', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(NEW_SLOT),
      });
      const slot = await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create({ ...CREATE, now: new Date('2026-01-01T02:00:00Z') });

      expect(writer.openSlot).toHaveBeenCalledWith(FAKE_CLIENT, 's-1', { weekday: 1, startTime: '08:00', durationMinutes: 240 }, '2025-12-31', 'u-1');
      expect(writer.closeSlot).not.toHaveBeenCalled();
      expect(slot).toEqual({ id: 'slot-new', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00' });
    });

    it('23P01 no openSlot (ServiceSlotOverlapError) propaga', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        openSlot: jest.fn().mockRejectedValue(new ServiceSlotOverlapError('s-1')),
      });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).create(CREATE)).rejects.toThrow(ServiceSlotOverlapError);
    });
  });

  describe('update', () => {
    const base = (over: Partial<ItinerarySlotWriterPort> = {}) =>
      writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValueOnce(OLD_SLOT).mockResolvedValue({ ...NEW_SLOT, id: 'slot-new', weekday: 3, startTime: '09:00', durationMinutes: 120, endTime: '11:00' }),
        ...over,
      });

    it('update fecha a antiga e abre a nova (ordem)', async () => {
      const ordem: string[] = [];
      const writer = base({
        closeSlot: jest.fn(async () => { ordem.push('close'); }),
        openSlot: jest.fn(async () => { ordem.push('open'); return 'slot-new'; }),
      });
      const slot = await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update({ ...UPDATE, now: new Date('2026-10-18T15:00:00Z') });

      expect(ordem).toEqual(['close', 'open']);
      expect(writer.closeSlot).toHaveBeenCalledWith(FAKE_CLIENT, 'slot-1', '2026-10-18', 'u-1');
      expect(writer.openSlot).toHaveBeenCalledWith(FAKE_CLIENT, 's-1', { weekday: 3, startTime: '09:00', durationMinutes: 120 }, '2026-10-18', 'u-1');
      expect(slot).toEqual({ id: 'slot-new', weekday: 3, startTime: '09:00', durationMinutes: 120, endTime: '11:00' });
    });

    it('slot inexistente/de outro serviço → SlotNotFoundError; nenhuma escrita', async () => {
      const writer = base({ findSlot: jest.fn().mockResolvedValue(null) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(SlotNotFoundError);
      semEscrita(writer);
    });

    it('faixa fechada → SlotInactiveError; nenhuma escrita', async () => {
      const writer = base({ findSlot: jest.fn().mockResolvedValue({ ...OLD_SLOT, vigente: false }) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(SlotInactiveError);
      semEscrita(writer);
    });

    it('alocação vigente → SlotHasActiveAllocationError sem escrita', async () => {
      const writer = base({ slotHasActiveAllocation: jest.fn().mockResolvedValue(true) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(SlotHasActiveAllocationError);
      semEscrita(writer);
    });

    it('sem endereço → ServiceWithoutAddressError; nenhuma escrita', async () => {
      const writer = base({ findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITHOUT_ADDRESS) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(ServiceWithoutAddressError);
      semEscrita(writer);
    });

    it('chave nova já vigente em OUTRA faixa do serviço → SlotAlreadyExistsError; nenhuma escrita', async () => {
      const writer = base({ readVigentSlots: jest.fn().mockResolvedValue([
        { id: 'slot-1', weekday: 2, startTime: '08:00', durationMinutes: 120 },
        { id: 'outra', weekday: 3, startTime: '09:00', durationMinutes: 120 },
      ]) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(SlotAlreadyExistsError);
      semEscrita(writer);
    });

    it('chave nova IGUAL à velha (sem mudança) → devolve a faixa, nenhuma escrita', async () => {
      const writer = base({ readVigentSlots: jest.fn().mockResolvedValue([{ id: 'slot-1', weekday: 2, startTime: '08:00', durationMinutes: 120 }]) });
      const slot = await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update({ ...UPDATE, weekday: 2, startTime: '08:00', durationMinutes: 120 });
      semEscrita(writer);
      expect(slot).toEqual({ id: 'slot-1', weekday: 2, startTime: '08:00', durationMinutes: 120, endTime: '10:00' });
    });

    it('23P01 ao abrir (ServiceSlotOverlapError) propaga — a transação do chamador desfaz o fechamento', async () => {
      const writer = base({ openSlot: jest.fn().mockRejectedValue(new ServiceSlotOverlapError('s-1')) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).update(UPDATE)).rejects.toThrow(ServiceSlotOverlapError);
    });
  });

  describe('end', () => {
    it('end fecha', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
      });
      await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).end({ ...END, now: new Date('2026-10-18T15:00:00Z') });
      expect(writer.closeSlot).toHaveBeenCalledTimes(1);
      expect(writer.closeSlot).toHaveBeenCalledWith(FAKE_CLIENT, 'slot-1', '2026-10-18', 'u-1');
      expect(writer.openSlot).not.toHaveBeenCalled();
    });

    it('slot inexistente → SlotNotFoundError; nenhuma escrita', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS), findSlot: jest.fn().mockResolvedValue(null) });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).end(END)).rejects.toThrow(SlotNotFoundError);
      semEscrita(writer);
    });

    it('faixa fechada → SlotInactiveError; nenhuma escrita', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue({ ...OLD_SLOT, vigente: false }),
      });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).end(END)).rejects.toThrow(SlotInactiveError);
      semEscrita(writer);
    });

    it('alocação vigente → SlotHasActiveAllocationError sem escrita', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(true),
      });
      await expect(new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).end(END)).rejects.toThrow(SlotHasActiveAllocationError);
      semEscrita(writer);
    });
  });

  it('hoje = operationDateOf(country, now) — findSlot e slotHasActiveAllocation recebem a data do país, não now() do processo', async () => {
    const writer = writerStub({
      findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
      findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
    });
    // 2026-01-01T02:00:00Z é 2025-12-31 no fuso de Buenos Aires (UTC-3) — prova que `hoje` não é o UTC do runner.
    await new ItinerarySlotWriteUseCase(writer, runInTransactionStub()).end({ ...END, now: new Date('2026-01-01T02:00:00Z') });
    expect(writer.findSlot.mock.calls[0][3]).toBe('2025-12-31');
    expect(writer.slotHasActiveAllocation.mock.calls[0][2]).toBe('2025-12-31');
  });
});
