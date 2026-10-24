/**
 * ItinerarySlotWriteUseCase — Fase 11, DX-11.5 (caso de uso), reescrito na spec 056 (T1.7). Criar/editar/encerrar
 * FAIXA do horário, tudo em `inPatientTransaction` (molde `ServiceTeamMarkUseCase.ts`): `patient_itinerary_slot` é o
 * dono do horário, então escrever = abrir/fechar faixa (vigência `valid`), nunca reescrever `pcs.schedule`.
 *   create — recusa chave vigente igual (`SlotAlreadyExistsError`) → `openSlot`.
 *   update — `resolveSlot` (existe, vigente em hoje, sem alocação vigente) → `closeSlot` → `openSlot`.
 *   end    — `resolveSlot` → `closeSlot`.
 * Serviço inexistente/de outro paciente/inativo → `ItineraryServiceNotFoundError`; sem endereço →
 * `ServiceWithoutAddressError` (invariante 8, nas TRÊS ações); faixa inexistente/de outro serviço →
 * `SlotNotFoundError`; faixa fechada → `SlotInactiveError`; alocação `ACTIVE` vigente em `hoje` →
 * `SlotHasActiveAllocationError` ("encerre a alocação primeiro"). A sobreposição é da constraint
 * `pis_sem_sobreposicao` (23P01 → `ServiceSlotOverlapError`, 409 `SLOT_OVERLAP`); a transação desfaz o fechamento.
 *
 * `hoje = operationDateOf(country, now)` — nunca `Date`/`now()` do banco. A forma da chave é do zod, na borda.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import type { ItinerarySlotKey } from '../domain/ItinerarySchedule';
import {
  ItinerarySlotWriter,
  type ServiceForWrite,
  type ItinerarySlotRow,
  type ItinerarySlotLookup,
} from '../infrastructure/ItinerarySlotWriter';
import type { VigentSlot } from '../infrastructure/ServiceSlotWriter';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';

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

/** `create` (ou `update` para a chave de OUTRA faixa) com a MESMA chave (weekday, startTime, durationMinutes) já vigente no serviço. */
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

/** Faixa já fechada (`valid` não contém hoje) — `update`/`end`/alocação recusam. */
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
  findSlot(client: PoolClient, serviceId: string, slotId: string, hoje: string): Promise<ItinerarySlotLookup | null>;
  slotHasActiveAllocation(client: PoolClient, slotId: string, hoje: string): Promise<boolean>;
  readVigentSlots(client: PoolClient, serviceId: string, hoje: string): Promise<VigentSlot[]>;
  openSlot(client: PoolClient, serviceId: string, key: ItinerarySlotKey, hoje: string, actorUid: string): Promise<string>;
  closeSlot(client: PoolClient, slotId: string, hoje: string, actorUid: string): Promise<void>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ItinerarySlotCreateInput {
  patientId: string;
  serviceId: string;
  weekday: number;
  startTime: string;
  durationMinutes: number;
  actorUid: string;
  now?: Date;
}

export interface ItinerarySlotUpdateInput extends ItinerarySlotCreateInput {
  slotId: string;
}

export interface ItinerarySlotEndInput {
  patientId: string;
  serviceId: string;
  slotId: string;
  actorUid: string;
  now?: Date;
}

/** A faixa que acabou de ser aberta não veio de volta — invariante quebrada, não erro de negócio. */
class ItinerarySlotOpenInvariantError extends Error {
  constructor(serviceId: string, slotId: string) {
    super(`opened itinerary slot not found: ${slotId} (serviceId=${serviceId})`);
    this.name = 'ItinerarySlotOpenInvariantError';
  }
}

export class ItinerarySlotWriteUseCase {
  constructor(
    private readonly writer: ItinerarySlotWriterPort = new ItinerarySlotWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
    /** ⚑13 (spec 056): o denominador da régua mudou → o estado do paciente é recalculado na MESMA transação. */
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
  ) {}

  async create(input: ItinerarySlotCreateInput): Promise<ItinerarySlotRow> {
    const { patientId, serviceId, weekday, startTime, durationMinutes, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);
      const hoje = operationDateOf(service.country, now);
      const key: ItinerarySlotKey = { weekday, startTime, durationMinutes };

      const vigentes = await this.writer.readVigentSlots(client, serviceId, hoje);
      if (vigentes.some((v) => sameKey(v, key))) throw new SlotAlreadyExistsError(serviceId, key);

      const newId = await this.writer.openSlot(client, serviceId, key, hoje, actorUid);
      const created = await this.mustFind(client, serviceId, newId, hoje);
      await this.derivation.run(client, patientId, now);
      return created;
    });
  }

  async update(input: ItinerarySlotUpdateInput): Promise<ItinerarySlotRow> {
    const { patientId, serviceId, slotId, weekday, startTime, durationMinutes, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);
      const hoje = operationDateOf(service.country, now);
      const oldSlot = await this.resolveSlot(client, serviceId, slotId, hoje);
      const newKey: ItinerarySlotKey = { weekday, startTime, durationMinutes };

      // Chave igual à da própria faixa: nada muda — sem fechar/abrir à toa (não vira histórico vazio).
      if (sameKey(oldSlot, newKey)) return toRow(oldSlot);

      // A chave NOVA já vigente em OUTRA faixa do serviço → mesmo erro do `create` (SLOT_ALREADY_EXISTS).
      const vigentes = await this.writer.readVigentSlots(client, serviceId, hoje);
      if (vigentes.some((v) => v.id !== slotId && sameKey(v, newKey))) throw new SlotAlreadyExistsError(serviceId, newKey);

      // Fechar ANTES de abrir; 23P01 no `openSlot` propaga e a transação desfaz o fechamento.
      await this.writer.closeSlot(client, slotId, hoje, actorUid);
      const newId = await this.writer.openSlot(client, serviceId, newKey, hoje, actorUid);
      const updated = await this.mustFind(client, serviceId, newId, hoje);
      await this.derivation.run(client, patientId, now);
      return updated;
    });
  }

  async end(input: ItinerarySlotEndInput): Promise<void> {
    const { patientId, serviceId, slotId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const service = await this.resolveService(client, patientId, serviceId);
      const hoje = operationDateOf(service.country, now);
      await this.resolveSlot(client, serviceId, slotId, hoje);
      await this.writer.closeSlot(client, slotId, hoje, actorUid);
      await this.derivation.run(client, patientId, now);
    });
  }

  /** Serviço existe (`patientId`+`serviceId`+`active`) e tem endereço — as duas recusas comuns às TRÊS ações. */
  private async resolveService(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceForWrite> {
    const service = await this.writer.findServiceForWrite(client, patientId, serviceId);
    if (service === null) throw new ItineraryServiceNotFoundError(patientId, serviceId);
    if (service.addressId === null) throw new ServiceWithoutAddressError(serviceId);
    return service;
  }

  /** Faixa existe (deste serviço), vigente em `hoje` e sem alocação vigente — comum a `update`/`end`. */
  private async resolveSlot(client: PoolClient, serviceId: string, slotId: string, hoje: string): Promise<ItinerarySlotLookup> {
    const slot = await this.writer.findSlot(client, serviceId, slotId, hoje);
    if (slot === null) throw new SlotNotFoundError(serviceId, slotId);
    if (!slot.vigente) throw new SlotInactiveError(serviceId, slotId);
    const hasActive = await this.writer.slotHasActiveAllocation(client, slotId, hoje);
    if (hasActive) throw new SlotHasActiveAllocationError(serviceId, slotId);
    return slot;
  }

  private async mustFind(client: PoolClient, serviceId: string, slotId: string, hoje: string): Promise<ItinerarySlotRow> {
    const slot = await this.writer.findSlot(client, serviceId, slotId, hoje);
    if (slot === null) throw new ItinerarySlotOpenInvariantError(serviceId, slotId);
    return toRow(slot);
  }
}

function toRow(slot: ItinerarySlotLookup): ItinerarySlotRow {
  return { id: slot.id, weekday: slot.weekday, startTime: slot.startTime, durationMinutes: slot.durationMinutes, endTime: slot.endTime };
}

function sameKey(
  a: { weekday: number; startTime: string; durationMinutes: number },
  b: { weekday: number; startTime: string; durationMinutes: number },
): boolean {
  return a.weekday === b.weekday && a.startTime === b.startTime && a.durationMinutes === b.durationMinutes;
}
