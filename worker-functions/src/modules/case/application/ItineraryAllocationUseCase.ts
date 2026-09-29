/**
 * ItineraryAllocationUseCase — DX-11.7 (caso de uso): a MESMA transação aloca (o gate de
 * Selecionado C, DX-11.6, e o 409 do banco, DX-11.3/DX-11.4) e encerra ("por derivação" —
 * `isVigente` para de contar a alocação `ENDED`; nenhuma marca de rejeição é gravada).
 *
 * Molde de injeção `ServiceTeamMarkUseCase.ts:115-123` (leitor, escritor, `runInTransaction`,
 * `now`): `reader` é o MESMO `ServiceTeamReader` da Fase 10 (`readWith`, no client da transação —
 * nenhuma 2ª leitura do time); `writer` é o `ItineraryAllocationWriter` (P12). `team` sai de
 * `deriveServiceTeamFromRows` (P8/P9) — nenhuma 2ª definição de Selecionado.
 *
 * `validFrom`/`hoje` sempre por `operationDateOf(row.country, now)` — nunca `Date`/`now()` do
 * processo fora do parâmetro injetável (DX-11.8). O estado do paciente só muda pela derivação
 * (cadeia Fase 15, DX-15.12): `derivation.run` no MESMO client, como a ÚLTIMA escrita da transação e
 * FORA do `try/catch` do insert (um erro de banco dela não pode virar 409 falso). Nenhuma escrita no
 * cadastro de prestadores do legado nem no card de atendimento antigo (Fase 14).
 *
 * "Slot não encontrado" é `SlotNotFoundError`, IMPORTADO de `ItinerarySlotWriteUseCase.ts` — fonte
 * única com `update`/`end` de slot (era uma 2ª classe própria aqui, `ItinerarySlotNotFoundError`,
 * mesma semântica e mesmo 404; consolidado no gate parcial #10).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import {
  ItineraryAllocationWriter,
  type AllocationSlot,
  type AllocationRow,
  type InsertAllocationInput,
  type InsertedAllocation,
} from '../infrastructure/ItineraryAllocationWriter';
import { deriveServiceTeamFromRows } from './serviceTeamPresentation';
import { canAllocate } from '../domain/itineraryAllocationGate';
import { fromPgError, type PgOverlapLikeError } from '../domain/itineraryOverlap';
import { ServiceWithoutAddressError, SlotInactiveError, SlotNotFoundError } from './ItinerarySlotWriteUseCase';

/** Nem Selecionado (C), nem Em Atendimento+candidato no mesmo slot (o gate `canAllocate`, DX-11.6). */
export class NotSelectedForServiceError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Worker is not selected for this service: ${workerId} (serviceId=${serviceId})`);
    this.name = 'NotSelectedForServiceError';
  }
}

/** Corrida no índice `uq_pia_open_pair` (23505): o mesmo prestador já está aberto neste slot. */
export class AlreadyAllocatedInSlotError extends Error {
  constructor(
    readonly slotId: string,
    readonly workerId: string,
  ) {
    super(`Worker already has an open allocation in this slot: ${workerId} (slotId=${slotId})`);
    this.name = 'AlreadyAllocatedInSlotError';
  }
}

/** Alocação inexistente, ou não pertence a este serviço/paciente — o controller mapeia para 404. */
export class AllocationNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly allocationId: string,
  ) {
    super(`Itinerary allocation not found: ${allocationId} (serviceId=${serviceId}, patientId=${patientId})`);
    this.name = 'AllocationNotFoundError';
  }
}

/** `end` numa alocação que já não está `ACTIVE` — encerrada/cancelada não encerra de novo. */
export class AllocationNotActiveError extends Error {
  constructor(readonly allocationId: string) {
    super(`Itinerary allocation is not active: ${allocationId}`);
    this.name = 'AllocationNotActiveError';
  }
}

export interface ItineraryAllocationReaderPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}

export interface ItineraryAllocationWriterPort {
  findSlotForAllocation(client: PoolClient, patientId: string, serviceId: string, slotId: string): Promise<AllocationSlot | null>;
  findApplicationId(client: PoolClient, workerId: string, vacancyId: string): Promise<string | null>;
  insertAllocation(client: PoolClient, input: InsertAllocationInput): Promise<InsertedAllocation>;
  findAllocation(client: PoolClient, patientId: string, serviceId: string, allocationId: string): Promise<AllocationRow | null>;
  endAllocation(client: PoolClient, id: string, today: string, actorUid: string): Promise<number>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ItineraryAllocateInput {
  patientId: string;
  serviceId: string;
  slotId: string;
  workerId: string;
  actorUid: string;
  now?: Date;
}

export interface ItineraryAllocationResult {
  allocationId: string;
  slotId: string;
  workerId: string;
  applicationId: string;
  validFrom: string;
  status: 'ACTIVE';
}

export interface ItineraryEndInput {
  patientId: string;
  serviceId: string;
  allocationId: string;
  actorUid: string;
  now?: Date;
}

export interface ItineraryEndResult {
  allocationId: string;
  status: 'ENDED';
  validTo: string;
}

/** O 23505 que é a corrida do índice `uq_pia_open_pair` — e só ele (molde `isActiveRejectionConflict`). */
function isOpenPairConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'uq_pia_open_pair';
}

export class ItineraryAllocationUseCase {
  constructor(
    private readonly reader: ItineraryAllocationReaderPort = new ServiceTeamReader(),
    private readonly writer: ItineraryAllocationWriterPort = new ItineraryAllocationWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
  ) {}

  async allocate(input: ItineraryAllocateInput): Promise<ItineraryAllocationResult> {
    const { patientId, serviceId, slotId, workerId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const slot = await this.writer.findSlotForAllocation(client, patientId, serviceId, slotId);
      if (slot === null) throw new SlotNotFoundError(serviceId, slotId);
      if (slot.addressId === null) throw new ServiceWithoutAddressError(serviceId);
      if (!slot.active) throw new SlotInactiveError(serviceId, slotId);

      const row = await this.reader.readWith(client, patientId, serviceId);
      if (row === null) throw new SlotNotFoundError(serviceId, slotId);

      const team = deriveServiceTeamFromRows(row, now);
      const candidacyIds = new Set(row.candidacies.map((c) => c.workerId));
      if (!canAllocate(team, candidacyIds, workerId)) throw new NotSelectedForServiceError(patientId, serviceId, workerId);

      if (row.liveVacancyId === null) throw new NotSelectedForServiceError(patientId, serviceId, workerId);
      const applicationId = await this.writer.findApplicationId(client, workerId, row.liveVacancyId);
      if (applicationId === null) throw new NotSelectedForServiceError(patientId, serviceId, workerId);

      const validFrom = operationDateOf(row.country, now);

      let inserted: InsertedAllocation;
      try {
        inserted = await this.writer.insertAllocation(client, { slotId, workerId, applicationId, validFrom, actorUid });
      } catch (err) {
        const overlap = fromPgError(err as PgOverlapLikeError);
        if (overlap !== null) throw overlap;
        if (isOpenPairConflict(err)) throw new AlreadyAllocatedInSlotError(slotId, workerId);
        throw err;
      }
      await this.derivation.run(client, patientId, now);
      return {
        allocationId: inserted.id,
        slotId,
        workerId,
        applicationId,
        validFrom: inserted.validFrom,
        status: 'ACTIVE' as const,
      };
    });
  }

  /** Encerrar devolve o prestador a Selecionado POR DERIVAÇÃO (`isVigente` para de contar `ENDED`); depois, a derivação do estado do paciente na mesma transação. */
  async end(input: ItineraryEndInput): Promise<ItineraryEndResult> {
    const { patientId, serviceId, allocationId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const allocation = await this.writer.findAllocation(client, patientId, serviceId, allocationId);
      if (allocation === null) throw new AllocationNotFoundError(patientId, serviceId, allocationId);
      if (allocation.status !== 'ACTIVE') throw new AllocationNotActiveError(allocationId);

      const row = await this.reader.readWith(client, patientId, serviceId);
      if (row === null) throw new AllocationNotFoundError(patientId, serviceId, allocationId);

      const today = operationDateOf(row.country, now);
      const rowCount = await this.writer.endAllocation(client, allocation.id, today, actorUid);
      if (rowCount === 0) throw new AllocationNotActiveError(allocationId);
      await this.derivation.run(client, patientId, now);

      return { allocationId: allocation.id, status: 'ENDED' as const, validTo: today };
    });
  }
}
