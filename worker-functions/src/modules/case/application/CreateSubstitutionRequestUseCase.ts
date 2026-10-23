/**
 * CreateSubstitutionRequestUseCase — spec 069, FR-10/FR-11 (DIAS: `ONE_DAY`/`DAYS`) e FR-16/FR-23/FR-30 (PERMANENTE: "No vuelve más").
 *
 * PERMANENTE (D ≥ hoje), UMA transação: cabeçalho → FR-23 (cancela as faltas abertas DELA com `on_date ≥ D` e limpa o substituto onde
 * ELA cobre com `on_date ≥ D`) → para CADA alocação `ACTIVE` dela no serviço: com substituto `replaceWith(derive:false)` + `REPLACE`; sem
 * substituto (FR-30) fim agendado em D−1 (ou cancela, se ela só começa em D) + `REMOVE` — ambos com o `request_id`. Destino só pergunta
 * com D = hoje (P6): com D > hoje grava `RESERVE`. Entrada futura dela = 409 (P5). A derivação do estado roda UMA vez, por ÚLTIMO.
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
import { addDaysToDateString } from '../domain/itineraryEvents';
import { DestinationNotAvailableForScheduledError, DestinationRequiredError } from '../domain/serviceExitReason';
import type { ItineraryChangeDestination } from '../infrastructure/ItineraryChangeLogWriter';
import type { WorkerAllocation } from '../infrastructure/ItineraryAllocationWriter';
import { ScheduledAttendanceReader, type ScheduledAttendances } from '../infrastructure/ScheduledAttendanceReader';
import { ItineraryAllocationUseCase, AllocationNotActiveError, type ItineraryReplaceInput, type ItineraryReplaceWithOptions, type ItineraryReplaceWithResult } from './ItineraryAllocationUseCase';
import { ServiceTeamMarkUseCase, type ServiceTeamMarkInput } from './ServiceTeamMarkUseCase';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { absenceErrorFromPg } from './ItineraryAbsenceUseCase';
import { resolveSubstituteApplicationId, type SubstituteApplicationPort } from './substituteCover';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
  WorkerHasPendingEntryError,
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

/** O que o "No vuelve más" usa além do que a parte DIAS já usa. Injetável em UM objeto (a parte DIAS não o toca). */
export interface PermanentExitDeps {
  allocations: { replaceWith(client: PoolClient, input: ItineraryReplaceInput, opts: ItineraryReplaceWithOptions): Promise<ItineraryReplaceWithResult> };
  schedule: {
    listWorkerAllocations(client: PoolClient, serviceId: string, workerId: string, fromDate: string): Promise<WorkerAllocation[]>;
    scheduleAllocationEnd(client: PoolClient, id: string, lastDay: string, actorUid: string): Promise<number>;
    cancelAllocation(client: PoolClient, id: string, minValidFrom: string, actorUid: string): Promise<number>;
  };
  absenceOps: {
    listOpenOfWorker(client: PoolClient, serviceId: string, workerId: string, fromDate: string): Promise<string[]>;
    cancelAbsence(client: PoolClient, id: string, actorUid: string): Promise<number>;
    updateSubstitute(client: PoolClient, id: string, substituteWorkerId: string | null, substituteApplicationId: string | null, actorUid: string): Promise<number>;
  };
  scheduled: { listFor(client: PoolClient, serviceId: string, workerId: string, today: string): Promise<ScheduledAttendances> };
  marks: { rejectWith(client: PoolClient, input: ServiceTeamMarkInput): Promise<unknown> };
  derivation: PatientStatusDerivationPort;
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

export interface CreatePermanentSubstitutionInput {
  patientId: string;
  serviceId: string;
  type: 'PERMANENT';
  outgoingWorkerId: string;
  /** D: o primeiro dia em que a pessoa NÃO está mais. */
  from: string;
  reasonCategory?: unknown;
  /** `RESERVE` | `LEAVE_SERVICE`; só é perguntado com D = hoje (P6) — `unknown` porque a borda deixa a ausência chegar aqui (422). */
  destination?: unknown;
  /** OBRIGATÓRIO no fio (P16): uuid de quem entra no lugar dela em todas as faixas, ou `null` = ninguém ainda (FR-30). */
  substituteWorkerId: string | null;
  actorUid: string;
  now?: Date;
}

export interface CreatePermanentSubstitutionResult {
  requestId: string;
  type: 'PERMANENT';
  from: string;
  to: null;
  /** Nº de alocações (faixas) da pessoa que saem. */
  shiftCount: number;
  destination: ItineraryChangeDestination;
  /** FR-23: faltas abertas DELA canceladas / turnos em que ela era substituta e ficaram sem substituto. */
  cancelledAbsences: number;
  clearedSubstitutes: number;
  allocations: Array<{ allocationId: string; newAllocationId: string | null }>;
}

const DESTINATIONS: readonly ItineraryChangeDestination[] = ['RESERVE', 'LEAVE_SERVICE'];

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
    private readonly exit: PermanentExitDeps = {
      allocations: new ItineraryAllocationUseCase(),
      schedule: new ItineraryAllocationWriter(),
      absenceOps: new ItineraryAbsenceWriter(),
      scheduled: new ScheduledAttendanceReader(),
      marks: new ServiceTeamMarkUseCase(),
      derivation: new PatientStatusDerivation(),
    },
  ) {}

  execute(input: CreateSubstitutionRequestInput): Promise<CreateSubstitutionRequestResult>;
  execute(input: CreatePermanentSubstitutionInput): Promise<CreatePermanentSubstitutionResult>;
  execute(input: CreateSubstitutionRequestInput | CreatePermanentSubstitutionInput): Promise<CreateSubstitutionRequestResult | CreatePermanentSubstitutionResult>;
  execute(input: CreateSubstitutionRequestInput | CreatePermanentSubstitutionInput): Promise<CreateSubstitutionRequestResult | CreatePermanentSubstitutionResult> {
    return input.type === 'PERMANENT' ? this.executePermanent(input) : this.executeDays(input);
  }

  private async executeDays(input: CreateSubstitutionRequestInput): Promise<CreateSubstitutionRequestResult> {
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

  /** "No vuelve más": ver o cabeçalho do arquivo. */
  private async executePermanent(input: CreatePermanentSubstitutionInput): Promise<CreatePermanentSubstitutionResult> {
    const { patientId, serviceId, outgoingWorkerId, from, reasonCategory, destination, substituteWorkerId, actorUid, now = new Date() } = input;
    if (reasonCategory === undefined || reasonCategory === null || reasonCategory === '') throw new ServiceExitReasonRequiredError();
    if (typeof reasonCategory !== 'string') throw new ServiceExitReasonInvalidError();
    const { allocations, schedule, absenceOps, scheduled, marks, derivation } = this.exit;

    return this.runInTransaction(async (client) => {
      const team = await this.team.readWith(client, patientId, serviceId);
      if (team === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);
      const hoje = operationDateOf(team.country, now);
      if (from < hoje) throw new SubstitutionPeriodInPastError(from);
      // P6: o destino só é perguntado com D = hoje; com D > hoje grava RESERVE e `LEAVE_SERVICE` agendado segue recusado (FR-32).
      let dest: ItineraryChangeDestination = 'RESERVE';
      if (from === hoje) {
        if (typeof destination !== 'string' || !DESTINATIONS.includes(destination as ItineraryChangeDestination)) throw new DestinationRequiredError();
        dest = destination as ItineraryChangeDestination;
      } else if (destination === 'LEAVE_SERVICE') {
        throw new DestinationNotAvailableForScheduledError();
      }

      if ((await this.reasonCatalog.findActiveByCode(client, reasonCategory)) === null) throw new ServiceExitReasonInvalidError();

      const own = await schedule.listWorkerAllocations(client, serviceId, outgoingWorkerId, from);
      if (own.length === 0) throw new SubstitutionNoShiftsInPeriodError(outgoingWorkerId, from, from);
      const agendado = await scheduled.listFor(client, serviceId, outgoingWorkerId, hoje);
      if (agendado.futureEntries.length > 0) throw new WorkerHasPendingEntryError(outgoingWorkerId); // P5

      const header = await this.requests.insert(client, { serviceId, outgoingWorkerId, reasonCode: reasonCategory, actorUid });

      // FR-23 ANTES de mexer nas alocações: as faltas dela e o substituto dela depois de D deixam de existir.
      let cancelledAbsences = 0;
      for (const absenceId of await absenceOps.listOpenOfWorker(client, serviceId, outgoingWorkerId, from)) {
        if ((await absenceOps.cancelAbsence(client, absenceId, actorUid)) > 0) cancelledAbsences += 1;
      }
      let clearedSubstitutes = 0;
      for (const sub of agendado.substitutions.filter((x) => x.date >= from)) {
        if ((await absenceOps.updateSubstitute(client, sub.absenceId, null, null, actorUid)) === 0) continue;
        clearedSubstitutes += 1;
        await this.changeLog.insert(client, {
          serviceId, kind: 'SUBSTITUTE_CANCELLED', outgoingWorkerId, absenceId: sub.absenceId, requestId: header.id,
          effectiveDate: sub.date, reasonCode: reasonCategory, actorUid,
        });
      }

      const done: Array<{ allocationId: string; newAllocationId: string | null }> = [];
      for (const allocation of own) {
        if (substituteWorkerId !== null) {
          const replaced = await allocations.replaceWith(client, { patientId, serviceId, allocationId: allocation.id, newWorkerId: substituteWorkerId, fromDate: from, actorUid, now }, { derive: false });
          await this.changeLog.insert(client, {
            serviceId, kind: 'REPLACE', outgoingWorkerId, incomingWorkerId: substituteWorkerId, assignmentId: allocation.id,
            newAssignmentId: replaced.newAllocationId, requestId: header.id, effectiveDate: replaced.validFrom, reasonCode: reasonCategory,
            destination: dest, actorUid,
          });
          done.push({ allocationId: allocation.id, newAllocationId: replaced.newAllocationId });
          continue;
        }
        // Sem substituto (FR-30): quem só começaria em D nunca atendeu → cancela; senão agenda o fim em D-1.
        const lastDay = addDaysToDateString(from, -1);
        const rows =
          allocation.validFrom >= from
            ? await schedule.cancelAllocation(client, allocation.id, from, actorUid)
            : await schedule.scheduleAllocationEnd(client, allocation.id, lastDay, actorUid);
        if (rows === 0) throw new AllocationNotActiveError(allocation.id);
        await this.changeLog.insert(client, {
          serviceId, kind: 'REMOVE', outgoingWorkerId, assignmentId: allocation.id, requestId: header.id, effectiveDate: lastDay,
          reasonCode: reasonCategory, destination: dest, actorUid,
        });
        done.push({ allocationId: allocation.id, newAllocationId: null });
      }

      if (dest === 'LEAVE_SERVICE') {
        await marks.rejectWith(client, { patientId, serviceId, workerId: outgoingWorkerId, reasonCategory, actorUid, cells: null, now });
      }
      // Derivação do estado: UMA vez, por ÚLTIMO e fora de try/catch (FR-16; molde `ItineraryAllocationUseCase.ts:12-15`).
      await derivation.run(client, patientId, now);

      return { requestId: header.id, type: 'PERMANENT' as const, from, to: null, shiftCount: done.length, destination: dest, cancelledAbsences, clearedSubstitutes, allocations: done };
    });
  }
}
