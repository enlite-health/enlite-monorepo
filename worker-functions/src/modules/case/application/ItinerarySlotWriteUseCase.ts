/**
 * ItinerarySlotWriteUseCase — Fase 11, DX-11.5 (caso de uso). Criar/editar/encerrar slot, tudo em
 * `inPatientTransaction` (molde `ServiceTeamMarkUseCase.ts`): serviço inexistente/de outro
 * paciente/inativo → `ItineraryServiceNotFoundError`; sem endereço → `ServiceWithoutAddressError`
 * (invariante 8, nas TRÊS ações); a chave já ATIVA no serviço (`create`) → `SlotAlreadyExistsError`;
 * slot inexistente/de outro serviço (`update`/`end`) → `SlotNotFoundError`; inativo →
 * `SlotInactiveError`; com alocação `ACTIVE` vigente em `hoje` → `SlotHasActiveAllocationError`
 * ("encerre a alocação primeiro" — editar/encerrar por baixo de alguém alocado mudaria o
 * compromisso sem passar pela trava do banco).
 *
 * `hoje = operationDateOf(country, now)` — nunca `Date`/`now()` do banco (a vigência da alocação
 * compara datas locais do país do paciente). `scheduleToSlots` (`CASE/domain/ItinerarySchedule.ts`)
 * é a ÚNICA fonte de "chave já ativa" e do dedup ao trocar a chave — nenhuma forma validada aqui
 * além dele (a forma é do zod, na borda).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { scheduleToSlots, type ScheduleEntry, type ItinerarySlotKey } from '../domain/ItinerarySchedule';
import { ItinerarySlotWriter, type ServiceForWrite, type ItinerarySlotRow } from '../infrastructure/ItinerarySlotWriter';

/** Serviço inexistente, de outro paciente, ou inativo — o controller mapeia para 404. */
export class ItineraryServiceNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
  ) {
    super(`Contracted service not found for itinerary write: ${serviceId} (patientId=${patientId})`);
    this.name = 'ItineraryServiceNotFoundError';
  }
}

/** Serviço sem `address_id` — o controller mapeia para 422 (invariante 8: nunca escreve slot sem endereço). */
export class ServiceWithoutAddressError extends Error {
  constructor(readonly serviceId: string) {
    super(`Contracted service has no address, cannot write itinerary slot: ${serviceId}`);
    this.name = 'ServiceWithoutAddressError';
  }
}

/** `create` com a MESMA chave (weekday, startTime, endTime) já ativa no schedule do serviço. */
export class SlotAlreadyExistsError extends Error {
  constructor(
    readonly serviceId: string,
    readonly key: ItinerarySlotKey,
  ) {
    super(`Itinerary slot key already active in this service: ${serviceId}`);
    this.name = 'SlotAlreadyExistsError';
  }
}

/** Slot inexistente, ou pertence a outro serviço — o controller mapeia para 404. */
export class SlotNotFoundError extends Error {
  constructor(
    readonly serviceId: string,
    readonly slotId: string,
  ) {
    super(`Itinerary slot not found for this service: ${slotId} (serviceId=${serviceId})`);
    this.name = 'SlotNotFoundError';
  }
}

/** Slot já `active = false` — `update`/`end` recusam (o slot já saiu do schedule). */
export class SlotInactiveError extends Error {
  constructor(
    readonly serviceId: string,
    readonly slotId: string,
  ) {
    super(`Itinerary slot is inactive: ${slotId} (serviceId=${serviceId})`);
    this.name = 'SlotInactiveError';
  }
}

/** Slot com alocação `ACTIVE` vigente em `hoje` — "encerre a alocação primeiro". */
export class SlotHasActiveAllocationError extends Error {
  constructor(
    readonly serviceId: string,
    readonly slotId: string,
  ) {
    super(`Itinerary slot has an active allocation, end it first: ${slotId} (serviceId=${serviceId})`);
    this.name = 'SlotHasActiveAllocationError';
  }
}

export interface ItinerarySlotWriterPort {
  findServiceForWrite(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceForWrite | null>;
  findSlot(client: PoolClient, serviceId: string, slotId: string): Promise<ItinerarySlotRow | null>;
  slotHasActiveAllocation(client: PoolClient, slotId: string, hoje: string): Promise<boolean>;
  writeSchedule(client: PoolClient, serviceId: string, schedule: ScheduleEntry[] | null, actorUid: string): Promise<void>;
  findSlotByKey(client: PoolClient, serviceId: string, key: ItinerarySlotKey): Promise<ItinerarySlotRow | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ItinerarySlotCreateInput {
  patientId: string;
  serviceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  actorUid: string;
  now?: Date;
}

export interface ItinerarySlotUpdateInput {
  patientId: string;
  serviceId: string;
  slotId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  actorUid: string;
  now?: Date;
}

export interface ItinerarySlotEndInput {
  patientId: string;
  serviceId: string;
  slotId: string;
  actorUid: string;
  now?: Date;
}

/** A linha que `writeSchedule` gravou não veio de volta — invariante quebrada da derivação, não erro de negócio. */
class ItinerarySlotSyncInvariantError extends Error {
  constructor(serviceId: string, key: ItinerarySlotKey) {
    super(`syncItinerarySlots did not produce the expected key: ${serviceId} ${JSON.stringify(key)}`);
    this.name = 'ItinerarySlotSyncInvariantError';
  }
}

export class ItinerarySlotWriteUseCase {
  constructor(
    private readonly writer: ItinerarySlotWriterPort = new ItinerarySlotWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async create(input: ItinerarySlotCreateInput): Promise<ItinerarySlotRow> {
    const { patientId, serviceId, weekday, startTime, endTime, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);

      const activeKeys = scheduleToSlots(service.schedule);
      const key: ItinerarySlotKey = { weekday, startTime, endTime };
      if (activeKeys.some((k) => sameKey(k, key))) {
        throw new SlotAlreadyExistsError(serviceId, key);
      }

      const nextSchedule: ScheduleEntry[] = [...(service.schedule ?? []), { dayOfWeek: weekday, startTime, endTime }];
      await this.writer.writeSchedule(client, serviceId, nextSchedule, actorUid);
      return this.mustFindByKey(client, serviceId, key);
    });
  }

  async update(input: ItinerarySlotUpdateInput): Promise<ItinerarySlotRow> {
    const { patientId, serviceId, slotId, weekday, startTime, endTime, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);
      const hoje = operationDateOf(service.country, now);
      const oldSlot = await this.resolveSlot(client, serviceId, slotId, hoje);

      const oldKey: ItinerarySlotKey = { weekday: oldSlot.weekday, startTime: oldSlot.startTime, endTime: oldSlot.endTime };
      const newKey: ItinerarySlotKey = { weekday, startTime, endTime };
      // Toda entrada da chave VELHA sai; as outras ficam intactas (scheduleToSlots dedupa o resto).
      const withoutOld = (service.schedule ?? []).filter((e) => !sameKey({ weekday: e.dayOfWeek, startTime: e.startTime, endTime: e.endTime }, oldKey));
      const nextSchedule: ScheduleEntry[] = [...withoutOld, { dayOfWeek: weekday, startTime, endTime }];

      await this.writer.writeSchedule(client, serviceId, nextSchedule, actorUid);
      return this.mustFindByKey(client, serviceId, newKey);
    });
  }

  async end(input: ItinerarySlotEndInput): Promise<void> {
    const { patientId, serviceId, slotId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);
      const hoje = operationDateOf(service.country, now);
      const oldSlot = await this.resolveSlot(client, serviceId, slotId, hoje);

      const oldKey: ItinerarySlotKey = { weekday: oldSlot.weekday, startTime: oldSlot.startTime, endTime: oldSlot.endTime };
      const withoutOld = (service.schedule ?? []).filter((e) => !sameKey({ weekday: e.dayOfWeek, startTime: e.startTime, endTime: e.endTime }, oldKey));

      await this.writer.writeSchedule(client, serviceId, withoutOld, actorUid);
    });
  }

  /** Serviço existe (`patientId`+`serviceId`+`active`) e tem endereço — as duas recusas comuns às TRÊS ações. */
  private async resolveService(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceForWrite> {
    const service = await this.writer.findServiceForWrite(client, patientId, serviceId);
    if (service === null) throw new ItineraryServiceNotFoundError(patientId, serviceId);
    if (service.addressId === null) throw new ServiceWithoutAddressError(serviceId);
    return service;
  }

  /** Slot existe (deste serviço), está ativo e sem alocação vigente — comum a `update`/`end`. */
  private async resolveSlot(client: PoolClient, serviceId: string, slotId: string, hoje: string): Promise<ItinerarySlotRow> {
    const slot = await this.writer.findSlot(client, serviceId, slotId);
    if (slot === null) throw new SlotNotFoundError(serviceId, slotId);
    if (!slot.active) throw new SlotInactiveError(serviceId, slotId);
    const hasActive = await this.writer.slotHasActiveAllocation(client, slotId, hoje);
    if (hasActive) throw new SlotHasActiveAllocationError(serviceId, slotId);
    return slot;
  }

  private async mustFindByKey(client: PoolClient, serviceId: string, key: ItinerarySlotKey): Promise<ItinerarySlotRow> {
    const slot = await this.writer.findSlotByKey(client, serviceId, key);
    if (slot === null) throw new ItinerarySlotSyncInvariantError(serviceId, key);
    return slot;
  }
}

function sameKey(a: ItinerarySlotKey, b: ItinerarySlotKey): boolean {
  return a.weekday === b.weekday && a.startTime === b.startTime && a.endTime === b.endTime;
}
