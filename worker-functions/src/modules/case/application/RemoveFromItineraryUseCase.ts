/**
 * RemoveFromItineraryUseCase — tirar um prestador do itinerário pela tela, com motivo e destino
 * (change itinerario-trocas-motivos-e-figma, Fase 4, design D4-C6 "Tirar com destino").
 *
 * UMA `inPatientTransaction`. Motivo ausente e destino ausente/fora de `RESERVE`|`LEAVE_SERVICE` saem
 * ANTES do banco; motivo inexistente/inativo no catálogo sai dentro da transação, ANTES de qualquer
 * escrita. Depois, NESTA ordem e no MESMO client:
 *   1. `endWith(derive: false)`  — encerra a alocação (o prestador volta a Selecionado por derivação);
 *   2. `ItineraryChangeLogWriter.insert(kind REMOVE)` — registro da troca;
 *   3. `LEAVE_SERVICE` → `rejectWith` com o MESMO código de motivo (marca de rejeição);
 *      se o prestador ainda tem agendamento (alocação futura), o `rejectWith` recusa com
 *      `ServiceTeamWorkerAllocatedError` e a transação inteira desfaz (a Fase 8 troca isso por aviso);
 *   4. `derivation.run` por ÚLTIMO e FORA de `try/catch` (regra da cadeia, `ItineraryAllocationUseCase.ts:12-15`).
 * `RESERVE` não grava marca: Selecionado é derivado. Nenhuma escrita em `worker_job_applications`.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { ItineraryAllocationUseCase, type ItineraryEndInput, type ItineraryEndWithResult } from './ItineraryAllocationUseCase';
import { ServiceTeamMarkUseCase, type ServiceTeamMarkInput } from './ServiceTeamMarkUseCase';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { ItineraryChangeLogWriter, type InsertItineraryChangeInput, type ItineraryChangeDestination } from '../infrastructure/ItineraryChangeLogWriter';
import { ServiceExitReasonReader, type ServiceExitReasonOption } from '../infrastructure/ServiceExitReasonReader';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError, DestinationRequiredError } from '../domain/serviceExitReason';

export interface RemoveFromItineraryAllocationPort {
  endWith(client: PoolClient, input: ItineraryEndInput, opts: { derive: boolean }): Promise<ItineraryEndWithResult>;
}

export interface RemoveFromItineraryRejectPort {
  rejectWith(client: PoolClient, input: ServiceTeamMarkInput): Promise<unknown>;
}

export interface RemoveFromItineraryReasonCatalogPort {
  findActiveByCode(client: PoolClient, code: string): Promise<ServiceExitReasonOption | null>;
}

export interface RemoveFromItineraryChangeLogPort {
  insert(client: PoolClient, input: InsertItineraryChangeInput): Promise<{ id: string }>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface RemoveFromItineraryInput {
  patientId: string;
  serviceId: string;
  allocationId: string;
  /** `code` de um item ATIVO do catálogo de motivos de saída; `unknown` porque a borda deixa a ausência chegar aqui (422, não 400). */
  reasonCategory?: unknown;
  /** `RESERVE` | `LEAVE_SERVICE`; `unknown` pelo mesmo motivo. */
  destination?: unknown;
  actorUid: string;
  now?: Date;
}

export interface RemoveFromItineraryResult {
  allocationId: string;
  status: 'ENDED';
  validTo: string;
  destination: ItineraryChangeDestination;
}

const DESTINATIONS: readonly ItineraryChangeDestination[] = ['RESERVE', 'LEAVE_SERVICE'];

export class RemoveFromItineraryUseCase {
  constructor(
    private readonly allocations: RemoveFromItineraryAllocationPort = new ItineraryAllocationUseCase(),
    private readonly marks: RemoveFromItineraryRejectPort = new ServiceTeamMarkUseCase(),
    private readonly reasonCatalog: RemoveFromItineraryReasonCatalogPort = new ServiceExitReasonReader(),
    private readonly changeLog: RemoveFromItineraryChangeLogPort = new ItineraryChangeLogWriter(),
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: RemoveFromItineraryInput): Promise<RemoveFromItineraryResult> {
    const { patientId, serviceId, allocationId, reasonCategory, destination, actorUid, now = new Date() } = input;
    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') throw new ServiceExitReasonRequiredError();
    if (typeof reasonCategory !== 'string') throw new ServiceExitReasonInvalidError();
    if (typeof destination !== 'string' || !DESTINATIONS.includes(destination as ItineraryChangeDestination)) {
      throw new DestinationRequiredError();
    }
    const dest = destination as ItineraryChangeDestination;

    return this.runInTransaction(async (client) => {
      // Motivo do catálogo (ativo), conferido ANTES de qualquer escrita.
      if ((await this.reasonCatalog.findActiveByCode(client, reasonCategory)) === null) throw new ServiceExitReasonInvalidError();

      const ended = await this.allocations.endWith(client, { patientId, serviceId, allocationId, actorUid, now }, { derive: false });
      if (!ended.workerId) throw new Error(`allocation without titular worker: ${allocationId}`);

      await this.changeLog.insert(client, {
        serviceId,
        kind: 'REMOVE',
        outgoingWorkerId: ended.workerId,
        assignmentId: allocationId,
        effectiveDate: ended.validTo,
        reasonCode: reasonCategory,
        destination: dest,
        actorUid,
      });

      if (dest === 'LEAVE_SERVICE') {
        await this.marks.rejectWith(client, { patientId, serviceId, workerId: ended.workerId, reasonCategory, actorUid, cells: null, now });
      }

      await this.derivation.run(client, patientId, now);
      return { allocationId: ended.allocationId, status: ended.status, validTo: ended.validTo, destination: dest };
    });
  }
}
