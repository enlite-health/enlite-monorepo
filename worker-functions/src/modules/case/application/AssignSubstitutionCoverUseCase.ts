/**
 * AssignSubstitutionCoverUseCase — spec 069, FR-20 "Elegir quién entra": põe quem cobre num pedido que ficou sem ninguém. UMA
 * transação; pedido desfeito = 409 `REQUEST_ALREADY_UNDONE`; nada sem ninguém a cobrir = 409 `NOTHING_TO_COVER`.
 *  - DIAS: `setSubstituteWith` (o mesmo corpo do `setSubstitute` avulso: gate do pool, `piab_*`, e o gatilho do banco chama o conflito
 *    com `p_ignore_absence` = a própria ausência) em CADA ausência futura do pedido sem substituto. Não move o paciente.
 *  - PERMANENTE sem substituto: para cada saída (`REMOVE`) ainda sem `REPLACE`, aloca a pessoa na MESMA faixa a partir de
 *    `max(D, hoje)` e grava `REPLACE` com o `request_id`, `assignment_id` = a alocação do titular que saiu, `new_assignment_id` = a
 *    nova e o `destination` do `REMOVE` (a ligação que o desfazer e o `ScheduledAttendanceReader` leem). Derivação por ÚLTIMO.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { ItineraryAbsenceUseCase, type ItineraryAbsenceResult, type ItineraryAbsenceSetSubstituteInput } from './ItineraryAbsenceUseCase';
import { AlreadyAllocatedInSlotError, AllocationNotFoundError, isOpenPairConflict } from './ItineraryAllocationUseCase';
import { resolveSubstituteApplicationId } from './substituteCover';
import { exitSinceOf, loadRequest, type SubstitutionRequestReaderPort } from './substitutionRequestLoad';
import { SubstitutionNothingToCoverError, SubstitutionServiceNotFoundError } from './substitutionRequestErrors';
import { SubstitutionRequestReader } from '../infrastructure/SubstitutionRequestReader';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { ItineraryAllocationWriter, type AllocationRow, type InsertAllocationInput, type InsertedAllocation } from '../infrastructure/ItineraryAllocationWriter';
import { ItineraryChangeLogWriter, type InsertItineraryChangeInput } from '../infrastructure/ItineraryChangeLogWriter';
import { fromPgError, type PgOverlapLikeError } from '../domain/itineraryOverlap';
import type { SubstitutionRequestType } from '../domain/substitutionRequest';

export interface CoverAbsencePort {
  setSubstituteWith(client: PoolClient, input: ItineraryAbsenceSetSubstituteInput): Promise<ItineraryAbsenceResult>;
}
export interface CoverTeamPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}
export interface CoverAllocationPort {
  findAllocation(client: PoolClient, patientId: string, serviceId: string, allocationId: string): Promise<AllocationRow | null>;
  findApplicationId(client: PoolClient, workerId: string, vacancyId: string): Promise<string | null>;
  insertAllocation(client: PoolClient, input: InsertAllocationInput): Promise<InsertedAllocation>;
}
export interface CoverLogPort {
  insert(client: PoolClient, input: InsertItineraryChangeInput): Promise<{ id: string }>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface AssignSubstitutionCoverInput {
  patientId: string;
  serviceId: string;
  requestId: string;
  substituteWorkerId: string;
  actorUid: string;
  now?: Date;
}

export interface AssignSubstitutionCoverResult {
  requestId: string;
  type: SubstitutionRequestType;
  /** Dias: ausências que ganharam substituto. Permanente: faixas que ganharam a nova alocação. */
  covered: number;
}

export class AssignSubstitutionCoverUseCase {
  constructor(
    private readonly reader: SubstitutionRequestReaderPort = new SubstitutionRequestReader(),
    private readonly absenceUseCase: CoverAbsencePort = new ItineraryAbsenceUseCase(),
    private readonly team: CoverTeamPort = new ServiceTeamReader(),
    private readonly allocations: CoverAllocationPort = new ItineraryAllocationWriter(),
    private readonly changeLog: CoverLogPort = new ItineraryChangeLogWriter(),
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: AssignSubstitutionCoverInput): Promise<AssignSubstitutionCoverResult> {
    const { patientId, serviceId, requestId, substituteWorkerId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const { header, view, hoje, absences, logRows } = await loadRequest(this.reader, client, { patientId, serviceId, requestId }, now);

      if (view.type !== 'PERMANENT') {
        const targets = absences.filter((a) => a.cancelledAt === null && a.onDate >= hoje && a.substituteWorkerId === null);
        if (targets.length === 0) throw new SubstitutionNothingToCoverError(requestId);
        for (const absence of targets) {
          await this.absenceUseCase.setSubstituteWith(client, { patientId, serviceId, absenceId: absence.absenceId, substituteWorkerId, actorUid, now });
        }
        return { requestId, type: view.type, covered: targets.length };
      }

      const replaced = new Set(logRows.filter((r) => r.kind === 'REPLACE').map((r) => r.assignmentId));
      const targets = logRows.filter((r) => r.kind === 'REMOVE' && r.assignmentId !== null && !replaced.has(r.assignmentId));
      if (targets.length === 0) throw new SubstitutionNothingToCoverError(requestId);

      const team = await this.team.readWith(client, patientId, serviceId);
      if (team === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);
      const applicationId = await resolveSubstituteApplicationId(this.allocations, client, { patientId, serviceId, team, now }, substituteWorkerId);

      for (const exit of targets) {
        const titularId = exit.assignmentId as string;
        const titular = await this.allocations.findAllocation(client, patientId, serviceId, titularId);
        if (titular?.slotId === undefined) throw new AllocationNotFoundError(patientId, serviceId, titularId);
        const exitDay = exitSinceOf(exit);
        const validFrom = exitDay > hoje ? exitDay : hoje;
        let inserted: InsertedAllocation;
        try {
          inserted = await this.allocations.insertAllocation(client, { slotId: titular.slotId, workerId: substituteWorkerId, applicationId, validFrom, actorUid });
        } catch (err) {
          const overlap = fromPgError(err as PgOverlapLikeError);
          if (overlap !== null) throw overlap;
          if (isOpenPairConflict(err)) throw new AlreadyAllocatedInSlotError(titular.slotId, substituteWorkerId);
          throw err;
        }
        await this.changeLog.insert(client, {
          serviceId, kind: 'REPLACE', outgoingWorkerId: header.outgoingWorkerId, incomingWorkerId: substituteWorkerId, assignmentId: titularId,
          newAssignmentId: inserted.id, requestId, effectiveDate: inserted.validFrom, reasonCode: header.reasonCode,
          destination: exit.destination ?? 'RESERVE', actorUid,
        });
      }

      await this.derivation.run(client, patientId, now);
      return { requestId, type: view.type, covered: targets.length };
    });
  }
}
