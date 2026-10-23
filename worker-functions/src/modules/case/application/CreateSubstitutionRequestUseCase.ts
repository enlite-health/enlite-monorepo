/**
 * CreateSubstitutionRequestUseCase — spec 069, FR-10/FR-11 (parte DIAS: `ONE_DAY`/`DAYS`; o "No vuelve más" entra na F3).
 *
 * UM pedido = UMA transação (`inPatientTransaction`, nunca `pool.connect()` cru): cabeçalho → N ausências → N registros
 * `ABSENCE` (cada um com o `request_id`). Qualquer falha — inclusive o 23P01 do gatilho de conflito no 3º turno — desfaz o
 * pedido inteiro, cabeçalho incluso (US5 aceite 4). Os turnos do período são DERIVADOS aqui (`shiftsOfWorkerInPeriod`) e o
 * corpo tem de trazer exatamente esses turnos, cada um com `substituteWorkerId` EXPLÍCITO (uuid ou `null` = "Nadie todavía",
 * P16): o servidor nunca assume um padrão.
 *
 * Gate do substituto: `substituteCover.ts` (a MESMA função da ausência avulsa). A data nunca é passada (`asOf` =
 * `operationDateOf(country, now)`). Falta temporária NÃO move o estado do paciente (spec §4): sem derivação aqui.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { ItineraryAbsenceWriter, type InsertAbsenceInput, type InsertedAbsence } from '../infrastructure/ItineraryAbsenceWriter';
import { ItineraryAllocationWriter } from '../infrastructure/ItineraryAllocationWriter';
import { ItineraryChangeLogWriter, type InsertItineraryChangeInput } from '../infrastructure/ItineraryChangeLogWriter';
import { SubstitutionRequestWriter, type InsertSubstitutionRequestInput } from '../infrastructure/SubstitutionRequestWriter';
import { ServiceExitReasonReader, type ServiceExitReasonOption } from '../infrastructure/ServiceExitReasonReader';
import { readServiceOccurrenceInputs, type OccurrenceInputs } from '../infrastructure/occurrenceInputs';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError } from '../domain/serviceExitReason';
import { datesBetween, shiftsOfWorkerInPeriod, type WorkerShift, type SubstitutionRequestType } from '../domain/substitutionRequest';
import { absenceErrorFromPg } from './ItineraryAbsenceUseCase';
import { resolveSubstituteApplicationId, type SubstituteApplicationPort } from './substituteCover';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
} from './substitutionRequestErrors';

export interface CreateSubstitutionTeamPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}
export interface CreateSubstitutionAbsencePort {
  insertAbsence(client: PoolClient, input: InsertAbsenceInput): Promise<InsertedAbsence>;
}
export interface CreateSubstitutionLogPort {
  insert(client: PoolClient, input: InsertItineraryChangeInput): Promise<{ id: string }>;
}
export interface CreateSubstitutionHeaderPort {
  insert(client: PoolClient, input: InsertSubstitutionRequestInput): Promise<{ id: string }>;
}
export interface CreateSubstitutionReasonPort {
  findActiveByCode(client: PoolClient, code: string): Promise<ServiceExitReasonOption | null>;
}
export interface CreateSubstitutionOccurrencesPort {
  readForService(client: PoolClient, patientId: string, serviceId: string, from: string, to: string): Promise<OccurrenceInputs>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface SubstitutionShiftInput {
  date: string;
  slotId: string;
  /** OBRIGATÓRIO no fio (P16): uuid, ou `null` = "Nadie todavía". */
  substituteWorkerId: string | null;
}

export interface CreateSubstitutionRequestInput {
  patientId: string;
  serviceId: string;
  type: Exclude<SubstitutionRequestType, 'PERMANENT'>;
  outgoingWorkerId: string;
  from: string;
  to: string;
  /** `unknown` porque a borda deixa a ausência chegar ao caso de uso (422, não 400). */
  reasonCategory?: unknown;
  shifts: SubstitutionShiftInput[];
  actorUid: string;
  now?: Date;
}

export interface CreatedSubstitutionAbsence {
  absenceId: string;
  assignmentId: string;
  slotId: string;
  date: string;
  substituteWorkerId: string | null;
}

export interface CreateSubstitutionRequestResult {
  requestId: string;
  type: Exclude<SubstitutionRequestType, 'PERMANENT'>;
  from: string;
  to: string;
  shiftCount: number;
  absences: CreatedSubstitutionAbsence[];
}

const shiftKey = (s: { date: string; slotId: string }): string => `${s.date}|${s.slotId}`;

/** Os turnos do corpo são EXATAMENTE os turnos da pessoa no período (sem faltar, sobrar ou repetir)? */
export function assertShiftsMatch(expected: readonly WorkerShift[], received: readonly SubstitutionShiftInput[]): void {
  const keys = new Set(received.map(shiftKey));
  if (keys.size !== received.length || received.length !== expected.length || expected.some((s) => !keys.has(shiftKey(s)))) {
    throw new SubstitutionShiftsMismatchError(expected.length, received.length);
  }
}

export class CreateSubstitutionRequestUseCase {
  constructor(
    private readonly team: CreateSubstitutionTeamPort = new ServiceTeamReader(),
    private readonly absences: CreateSubstitutionAbsencePort = new ItineraryAbsenceWriter(),
    private readonly allocationWriter: SubstituteApplicationPort = new ItineraryAllocationWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
    private readonly reasonCatalog: CreateSubstitutionReasonPort = new ServiceExitReasonReader(),
    private readonly changeLog: CreateSubstitutionLogPort = new ItineraryChangeLogWriter(),
    private readonly requests: CreateSubstitutionHeaderPort = new SubstitutionRequestWriter(),
    private readonly occurrences: CreateSubstitutionOccurrencesPort = { readForService: readServiceOccurrenceInputs },
  ) {}

  async execute(input: CreateSubstitutionRequestInput): Promise<CreateSubstitutionRequestResult> {
    const { patientId, serviceId, type, outgoingWorkerId, from, to, reasonCategory, shifts, actorUid, now = new Date() } = input;
    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') throw new ServiceExitReasonRequiredError();
    if (typeof reasonCategory !== 'string') throw new ServiceExitReasonInvalidError();

    return this.runInTransaction(async (client) => {
      const team = await this.team.readWith(client, patientId, serviceId);
      if (team === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);

      if (from < operationDateOf(team.country, now)) throw new SubstitutionPeriodInPastError(from);

      const inputs = await this.occurrences.readForService(client, patientId, serviceId, from, to);
      const expected = shiftsOfWorkerInPeriod(inputs.slots, inputs.assignments, outgoingWorkerId, datesBetween(from, to));
      if (expected.length === 0) throw new SubstitutionNoShiftsInPeriodError(outgoingWorkerId, from, to);
      assertShiftsMatch(expected, shifts);

      // Gate do substituto: uma candidatura por pessoa DISTINTA (a mesma função da ausência avulsa).
      const applicationByWorker = new Map<string, string>();
      for (const shift of shifts) {
        const workerId = shift.substituteWorkerId;
        if (workerId === null || applicationByWorker.has(workerId)) continue;
        applicationByWorker.set(workerId, await resolveSubstituteApplicationId(this.allocationWriter, client, { patientId, serviceId, team, now }, workerId));
      }

      if ((await this.reasonCatalog.findActiveByCode(client, reasonCategory)) === null) throw new ServiceExitReasonInvalidError();

      const header = await this.requests.insert(client, { serviceId, outgoingWorkerId, reasonCode: reasonCategory, actorUid });

      const substituteBy = new Map(shifts.map((s) => [shiftKey(s), s.substituteWorkerId]));
      const created: CreatedSubstitutionAbsence[] = [];
      for (const shift of expected) {
        const substituteWorkerId = substituteBy.get(shiftKey(shift)) ?? null;
        let inserted: InsertedAbsence;
        try {
          inserted = await this.absences.insertAbsence(client, {
            allocationId: shift.assignmentId,
            requestId: header.id,
            date: shift.date,
            substituteWorkerId,
            substituteApplicationId: substituteWorkerId === null ? null : (applicationByWorker.get(substituteWorkerId) as string),
            actorUid,
          });
        } catch (err) {
          throw absenceErrorFromPg(err, shift.assignmentId, shift.date) ?? err;
        }
        created.push({ absenceId: inserted.id, assignmentId: shift.assignmentId, slotId: shift.slotId, date: inserted.date, substituteWorkerId });
      }

      // Registro de trocas: MESMO client, DEPOIS das ausências, fora do try/catch de decodificação (erro aqui não é erro de ausência).
      for (const absence of created) {
        await this.changeLog.insert(client, {
          serviceId,
          kind: 'ABSENCE',
          outgoingWorkerId,
          incomingWorkerId: absence.substituteWorkerId,
          assignmentId: absence.assignmentId,
          absenceId: absence.absenceId,
          requestId: header.id,
          effectiveDate: absence.date,
          reasonCode: reasonCategory,
          actorUid,
        });
      }

      return { requestId: header.id, type, from, to, shiftCount: created.length, absences: created };
    });
  }
}
