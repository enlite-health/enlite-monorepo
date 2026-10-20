import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { ItineraryAllocationUseCase, type ItineraryReplaceInput, type ItineraryReplaceWithOptions, type ItineraryReplaceWithResult } from './ItineraryAllocationUseCase';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { ItineraryChangeLogWriter, type InsertItineraryChangeInput, type ItineraryChangeDestination } from '../infrastructure/ItineraryChangeLogWriter';
import { ServiceExitReasonReader, type ServiceExitReasonOption } from '../infrastructure/ServiceExitReasonReader';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError, DestinationRequiredError } from '../domain/serviceExitReason';

export interface ReplaceWithReasonAllocationPort {
  replaceWith(client: PoolClient, input: ItineraryReplaceInput, opts: ItineraryReplaceWithOptions): Promise<ItineraryReplaceWithResult>;
}
export interface ReplaceWithReasonCatalogPort { findActiveByCode(client: PoolClient, code: string): Promise<ServiceExitReasonOption | null> }
export interface ReplaceWithReasonChangeLogPort { insert(client: PoolClient, input: InsertItineraryChangeInput): Promise<{ id: string }> }
type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ReplaceWithReasonInput extends Omit<ItineraryReplaceInput, 'actorUid'> {
  /** `code` de um motivo ATIVO do catálogo; `unknown` porque a borda deixa a ausência chegar aqui (422, não 400). */
  reasonCategory?: unknown;
  /** `RESERVE` | `LEAVE_SERVICE`; `unknown` pelo mesmo motivo. */
  destination?: unknown;
  actorUid: string;
}
export interface ReplaceWithReasonResult {
  endedAllocationId: string; endedValidTo: string; newAllocationId: string; newWorkerId: string; validFrom: string;
  status: 'ACTIVE'; destination: ItineraryChangeDestination;
}
const DESTINATIONS: readonly ItineraryChangeDestination[] = ['RESERVE', 'LEAVE_SERVICE'];

export class ReplaceWithReasonUseCase {
  constructor(
    private readonly allocations: ReplaceWithReasonAllocationPort = new ItineraryAllocationUseCase(),
    private readonly reasonCatalog: ReplaceWithReasonCatalogPort = new ServiceExitReasonReader(),
    private readonly changeLog: ReplaceWithReasonChangeLogPort = new ItineraryChangeLogWriter(),
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: ReplaceWithReasonInput): Promise<ReplaceWithReasonResult> {
    const { reasonCategory, destination, now = new Date() } = input;
    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') throw new ServiceExitReasonRequiredError();
    if (typeof reasonCategory !== 'string') throw new ServiceExitReasonInvalidError();
    if (typeof destination !== 'string' || !DESTINATIONS.includes(destination as ItineraryChangeDestination)) throw new DestinationRequiredError();
    const dest = destination as ItineraryChangeDestination;

    return this.runInTransaction(async (client) => {
      if ((await this.reasonCatalog.findActiveByCode(client, reasonCategory)) === null) throw new ServiceExitReasonInvalidError();
      const replaced = await this.allocations.replaceWith(client, { ...input, now }, { derive: false });
      if (!replaced.outgoingWorkerId) throw new Error(`allocation without titular worker: ${input.allocationId}`);
      await this.changeLog.insert(client, {
        serviceId: input.serviceId, kind: 'REPLACE', outgoingWorkerId: replaced.outgoingWorkerId, incomingWorkerId: input.newWorkerId,
        assignmentId: input.allocationId, newAssignmentId: replaced.newAllocationId, effectiveDate: replaced.validFrom,
        reasonCode: reasonCategory, destination: dest, actorUid: input.actorUid,
      });
      await this.derivation.run(client, input.patientId, now);
      return {
        endedAllocationId: replaced.endedAllocationId, endedValidTo: replaced.endedValidTo, newAllocationId: replaced.newAllocationId,
        newWorkerId: replaced.newWorkerId, validFrom: replaced.validFrom, status: 'ACTIVE', destination: dest,
      };
    });
  }
}
