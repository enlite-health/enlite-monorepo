/**
 * ItinerarySlotWriteUseCase — Fase 11, DX-11.5 (caso de uso). `writer` e a TRANSAÇÃO
 * (`runInTransaction`) injetados — sem banco real (molde `ServiceTeamMarkUseCase.test.ts`). A
 * transação injetada só chama `fn` direto no client dublê.
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
import type { ServiceForWrite, ItinerarySlotRow } from '../../infrastructure/ItinerarySlotWriter';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

type RunInTransaction = ConstructorParameters<typeof ItinerarySlotWriteUseCase>[1];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

function writerStub(overrides: Partial<ItinerarySlotWriterPort> = {}): ItinerarySlotWriterPort & {
  findServiceForWrite: jest.Mock;
  findSlot: jest.Mock;
  slotHasActiveAllocation: jest.Mock;
  writeSchedule: jest.Mock;
  findSlotByKey: jest.Mock;
} {
  return {
    findServiceForWrite: jest.fn(),
    findSlot: jest.fn(),
    slotHasActiveAllocation: jest.fn(),
    writeSchedule: jest.fn(),
    findSlotByKey: jest.fn(),
    ...overrides,
  } as never;
}

const SERVICE_WITH_ADDRESS: ServiceForWrite = {
  id: 's-1',
  addressId: 'addr-1',
  schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '10:00' }],
  country: 'AR',
};

const SERVICE_WITHOUT_ADDRESS: ServiceForWrite = { id: 's-1', addressId: null, schedule: null, country: 'AR' };

const NEW_SLOT: ItinerarySlotRow = { id: 'slot-new', weekday: 1, startTime: '08:00', endTime: '12:00', active: true };

describe('ItinerarySlotWriteUseCase', () => {
  describe('create', () => {
    it('serviço inexistente → ItineraryServiceNotFoundError; 0 writeSchedule', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(null) });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.create({ patientId: 'p-1', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', actorUid: 'u-1' }),
      ).rejects.toThrow(ItineraryServiceNotFoundError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('sem endereço → ServiceWithoutAddressError; 0 writeSchedule', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITHOUT_ADDRESS) });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.create({ patientId: 'p-1', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', actorUid: 'u-1' }),
      ).rejects.toThrow(ServiceWithoutAddressError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('chave já ativa no schedule → SlotAlreadyExistsError; 0 writeSchedule', async () => {
      const service: ServiceForWrite = { id: 's-1', addressId: 'addr-1', schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }], country: 'AR' };
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(service) });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.create({ patientId: 'p-1', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', actorUid: 'u-1' }),
      ).rejects.toThrow(SlotAlreadyExistsError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('feliz → schedule\' = antigo + a entrada nova; devolve o slot achado por chave', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        writeSchedule: jest.fn().mockResolvedValue(undefined),
        findSlotByKey: jest.fn().mockResolvedValue(NEW_SLOT),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      const slot = await useCase.create({ patientId: 'p-1', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', actorUid: 'u-1' });

      expect(writer.writeSchedule).toHaveBeenCalledTimes(1);
      const [client, serviceId, schedule, actorUid] = writer.writeSchedule.mock.calls[0];
      expect(client).toBe(FAKE_CLIENT);
      expect(serviceId).toBe('s-1');
      expect(schedule).toEqual([
        { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' },
        { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      ]);
      expect(actorUid).toBe('u-1');
      expect(slot).toEqual(NEW_SLOT);
    });
  });

  describe('update', () => {
    const OLD_SLOT: ItinerarySlotRow = { id: 'slot-1', weekday: 2, startTime: '08:00', endTime: '10:00', active: true };

    it('slot inexistente/de outro serviço → SlotNotFoundError; 0 writeSchedule', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(null),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', actorUid: 'u-1' }),
      ).rejects.toThrow(SlotNotFoundError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('slot inativo → SlotInactiveError; 0 writeSchedule', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue({ ...OLD_SLOT, active: false }),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', actorUid: 'u-1' }),
      ).rejects.toThrow(SlotInactiveError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('com alocação ACTIVE vigente → SlotHasActiveAllocationError; 0 writeSchedule', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(true),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', actorUid: 'u-1' }),
      ).rejects.toThrow(SlotHasActiveAllocationError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('sem endereço → ServiceWithoutAddressError; 0 writeSchedule (as 3 ações)', async () => {
      const writer = writerStub({ findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITHOUT_ADDRESS) });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', actorUid: 'u-1' }),
      ).rejects.toThrow(ServiceWithoutAddressError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('chave nova já ativa em OUTRO slot do mesmo serviço → SlotAlreadyExistsError; 0 writeSchedule', async () => {
      const service: ServiceForWrite = {
        id: 's-1',
        addressId: 'addr-1',
        schedule: [
          { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' }, // OLD_SLOT (o que está sendo editado)
          { dayOfWeek: 4, startTime: '14:00', endTime: '16:00' }, // outro slot ATIVO — é a chave alvo do update
        ],
        country: 'AR',
      };
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(service),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(
        useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 4, startTime: '14:00', endTime: '16:00', actorUid: 'u-1' }),
      ).rejects.toThrow(SlotAlreadyExistsError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('chave nova IGUAL à velha (sem mudança de horário) → não é SlotAlreadyExistsError; grava normal', async () => {
      const service: ServiceForWrite = {
        id: 's-1',
        addressId: 'addr-1',
        schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '10:00' }],
        country: 'AR',
      };
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(service),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
        writeSchedule: jest.fn().mockResolvedValue(undefined),
        findSlotByKey: jest.fn().mockResolvedValue(OLD_SLOT),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 2, startTime: '08:00', endTime: '10:00', actorUid: 'u-1' });

      expect(writer.writeSchedule).toHaveBeenCalledTimes(1);
    });

    it('feliz → toda entrada da chave velha trocada pela nova; as outras entradas intactas', async () => {
      const service: ServiceForWrite = {
        id: 's-1',
        addressId: 'addr-1',
        schedule: [
          { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' },
          { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' }, // duplicata exata — some junto
          { dayOfWeek: 4, startTime: '14:00', endTime: '16:00' }, // outra chave — intacta
        ],
        country: 'AR',
      };
      const newSlot: ItinerarySlotRow = { id: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', active: true };
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(service),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
        writeSchedule: jest.fn().mockResolvedValue(undefined),
        findSlotByKey: jest.fn().mockResolvedValue(newSlot),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      const slot = await useCase.update({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', weekday: 3, startTime: '09:00', endTime: '11:00', actorUid: 'u-1' });

      const [, , schedule] = writer.writeSchedule.mock.calls[0];
      expect(schedule).toEqual([
        { dayOfWeek: 4, startTime: '14:00', endTime: '16:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '11:00' },
      ]);
      expect(slot).toEqual(newSlot);
    });
  });

  describe('end', () => {
    const OLD_SLOT: ItinerarySlotRow = { id: 'slot-1', weekday: 2, startTime: '08:00', endTime: '10:00', active: true };

    it('slot inexistente → SlotNotFoundError; 0 writeSchedule', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(null),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(useCase.end({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', actorUid: 'u-1' })).rejects.toThrow(SlotNotFoundError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('com alocação ACTIVE vigente → SlotHasActiveAllocationError; 0 writeSchedule', async () => {
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(SERVICE_WITH_ADDRESS),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(true),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await expect(useCase.end({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', actorUid: 'u-1' })).rejects.toThrow(SlotHasActiveAllocationError);
      expect(writer.writeSchedule).not.toHaveBeenCalled();
    });

    it('feliz → a chave some do schedule; writeSchedule 1x sem a entrada removida', async () => {
      const service: ServiceForWrite = {
        id: 's-1',
        addressId: 'addr-1',
        schedule: [
          { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' },
          { dayOfWeek: 4, startTime: '14:00', endTime: '16:00' },
        ],
        country: 'AR',
      };
      const writer = writerStub({
        findServiceForWrite: jest.fn().mockResolvedValue(service),
        findSlot: jest.fn().mockResolvedValue(OLD_SLOT),
        slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
        writeSchedule: jest.fn().mockResolvedValue(undefined),
      });
      const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());

      await useCase.end({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', actorUid: 'u-1' });

      expect(writer.writeSchedule).toHaveBeenCalledTimes(1);
      const [client, serviceId, schedule, actorUid] = writer.writeSchedule.mock.calls[0];
      expect(client).toBe(FAKE_CLIENT);
      expect(serviceId).toBe('s-1');
      expect(schedule).toEqual([{ dayOfWeek: 4, startTime: '14:00', endTime: '16:00' }]);
      expect(actorUid).toBe('u-1');
    });
  });

  it('hoje = operationDateOf(country, now) — slotHasActiveAllocation recebe a data derivada do país, não now() do processo', async () => {
    const service: ServiceForWrite = { id: 's-1', addressId: 'addr-1', schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '10:00' }], country: 'AR' };
    const oldSlot: ItinerarySlotRow = { id: 'slot-1', weekday: 2, startTime: '08:00', endTime: '10:00', active: true };
    const writer = writerStub({
      findServiceForWrite: jest.fn().mockResolvedValue(service),
      findSlot: jest.fn().mockResolvedValue(oldSlot),
      slotHasActiveAllocation: jest.fn().mockResolvedValue(false),
      writeSchedule: jest.fn().mockResolvedValue(undefined),
    });
    const useCase = new ItinerarySlotWriteUseCase(writer, runInTransactionStub());
    // 2026-01-01T02:00:00Z é 2025-12-31 no fuso de Buenos Aires (UTC-3) — prova que `hoje` não é o UTC do runner.
    const now = new Date('2026-01-01T02:00:00Z');

    await useCase.end({ patientId: 'p-1', serviceId: 's-1', slotId: 'slot-1', actorUid: 'u-1', now });

    const [, , hoje] = writer.slotHasActiveAllocation.mock.calls[0];
    expect(hoje).toBe('2025-12-31');
  });
});
