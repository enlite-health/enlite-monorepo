/**
 * PreviewSubstitutionRequestUseCase — spec 069, FR-15/US4/US5: a pré-visão do pedido. LEITURA pura (nunca escreve; o lock do
 * paciente da derivação fica de fora). Mesma entrada do create, sem os substitutos escolhidos; devolve:
 *  - os turnos da pessoa no período (data, faixa, início, fim) — o que a tela mostra no passo 2, nunca calculado no front;
 *  - o conflito TRI-ESTADO de cada candidato × turno, vindo de `itinerary_substitute_conflict_preview` (a MESMA montagem do
 *    gatilho da ausência): `free` · `conflict` · `unknown` (a função falhou — "no se pudo verificar"; falha nunca vira `free`);
 *  - o estado do paciente depois do pedido (`derivarEstadoPaciente`, a MESMA regra): falta temporária não move o estado, então
 *    `changes` é `false` por construção do pedido de dias.
 *
 * PERMANENTE ("No vuelve más", F3): `shifts` = UM por alocação (faixa) que sai a partir de D; o conflito de cada candidato usa
 * vigência ABERTA (`p_from = D`, `p_to = NULL`); `permanent` traz o que a confirmação diz — faltas dela que serão canceladas (FR-23),
 * turnos em que ela era substituta e ficam sem ninguém, e a entrada futura que bloqueia (P5). `statusAfter` = o estado SE NINGUÉM entrar
 * no lugar dela (a MESMA conta de horas sobre as faixas sem as alocações dela a partir de D, `PatientStatusDerivation.evaluate(simulate)`).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { ServiceTeamReader } from '../infrastructure/ServiceTeamReader';
import { readServiceOccurrenceInputs } from '../infrastructure/occurrenceInputs';
import {
  ConflictPreviewUnavailableError,
  SubstituteConflictPreviewReader,
  type ConflictOverlap,
  type ConflictPreviewInput,
} from '../infrastructure/SubstituteConflictPreviewReader';
import { derivarEstadoPaciente } from '../domain/derivarEstadoPaciente';
import { datesBetween, shiftsOfWorkerInPeriod, type SubstitutionRequestType, type WorkerShift } from '../domain/substitutionRequest';
import { PatientStatusDerivation, type DerivationEvaluation } from './PatientStatusDerivation';
import type { CreateSubstitutionOccurrencesPort, CreateSubstitutionTeamPort } from './CreateSubstitutionRequestUseCase';
import { SubstitutionNoShiftsInPeriodError, SubstitutionPeriodInPastError, SubstitutionServiceNotFoundError } from './substitutionRequestErrors';
import { ItineraryAbsenceWriter } from '../infrastructure/ItineraryAbsenceWriter';
import { ItineraryAllocationWriter, type WorkerAllocation } from '../infrastructure/ItineraryAllocationWriter';
import { ScheduledAttendanceReader, type ScheduledAttendances } from '../infrastructure/ScheduledAttendanceReader';
import { addDaysToDateString } from '../domain/itineraryEvents';
import type { KanbanServicesRows } from '../infrastructure/PatientKanbanServicesReader';
import type { DerivationSimulation } from './PatientStatusDerivation';

export interface ConflictPreviewPort {
  preview(client: PoolClient, input: ConflictPreviewInput): Promise<ConflictOverlap[]>;
}
export interface StatusEvaluationPort {
  evaluate(client: PoolClient, patientId: string, now: Date, opts: { lock: boolean; simulate?: DerivationSimulation }): Promise<DerivationEvaluation | null>;
}

/** O que o "No vuelve más" lê além da parte DIAS (só leitura). */
export interface PermanentPreviewDeps {
  schedule: { listWorkerAllocations(client: PoolClient, serviceId: string, workerId: string, fromDate: string): Promise<WorkerAllocation[]> };
  absenceOps: { listOpenOfWorker(client: PoolClient, serviceId: string, workerId: string, fromDate: string): Promise<string[]> };
  scheduled: { listFor(client: PoolClient, serviceId: string, workerId: string, today: string): Promise<ScheduledAttendances> };
}

export interface PreviewPermanentInput {
  patientId: string;
  serviceId: string;
  type: 'PERMANENT';
  outgoingWorkerId: string;
  /** D: o primeiro dia em que a pessoa NÃO está mais. */
  from: string;
  candidateWorkerIds: string[];
  now?: Date;
}

/** O que a confirmação do "No vuelve más" mostra (FR-23, P5). */
export interface PermanentPreview {
  allocationCount: number;
  /** Faltas abertas DELA com `on_date ≥ D` que serão canceladas. */
  cancelledAbsences: number;
  /** Turnos em que ELA é substituta com `on_date ≥ D` e ficarão sem substituto. */
  clearedSubstitutes: number;
  /** P5: tem entrada futura no serviço — o pedido será recusado (409 `WORKER_HAS_PENDING_ENTRY`). */
  pendingEntry: boolean;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface PreviewSubstitutionRequestInput {
  patientId: string;
  serviceId: string;
  type: Exclude<SubstitutionRequestType, 'PERMANENT'>;
  outgoingWorkerId: string;
  from: string;
  to: string;
  candidateWorkerIds: string[];
  now?: Date;
}

export type ConflictState = 'free' | 'conflict' | 'unknown';

export interface ShiftConflict {
  workerId: string;
  date: string;
  slotId: string;
  state: ConflictState;
  /** Os horários que colidem (só dia/hora/duração e "mesmo endereço"); vazio em `free`/`unknown`. */
  overlaps: ConflictOverlap[];
}

export interface SubstitutionStatusAfter {
  current: string | null;
  after: string | null;
  /** O PEDIDO muda o estado do paciente? (estado derivado depois × antes — não compara com o gravado). */
  changes: boolean;
}

export interface PreviewSubstitutionRequestResult {
  shifts: WorkerShift[];
  conflicts: ShiftConflict[];
  /** `null` = o paciente não é sujeito da derivação (sem estado a prever). */
  statusAfter: SubstitutionStatusAfter | null;
  /** Só no `PERMANENT`. */
  permanent?: PermanentPreview;
}

export class PreviewSubstitutionRequestUseCase {
  constructor(
    private readonly team: CreateSubstitutionTeamPort = new ServiceTeamReader(),
    private readonly occurrences: CreateSubstitutionOccurrencesPort = { readForService: readServiceOccurrenceInputs },
    private readonly conflicts: ConflictPreviewPort = new SubstituteConflictPreviewReader(),
    private readonly derivation: StatusEvaluationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
    private readonly exit: PermanentPreviewDeps = { schedule: new ItineraryAllocationWriter(), absenceOps: new ItineraryAbsenceWriter(), scheduled: new ScheduledAttendanceReader() },
  ) {}

  execute(input: PreviewSubstitutionRequestInput | PreviewPermanentInput): Promise<PreviewSubstitutionRequestResult> {
    return input.type === 'PERMANENT' ? this.executePermanent(input) : this.executeDays(input);
  }

  private async executePermanent(input: PreviewPermanentInput): Promise<PreviewSubstitutionRequestResult> {
    const { patientId, serviceId, outgoingWorkerId, from, candidateWorkerIds, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const team = await this.team.readWith(client, patientId, serviceId);
      if (team === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);
      const hoje = operationDateOf(team.country, now);
      if (from < hoje) throw new SubstitutionPeriodInPastError(from);

      const own = await this.exit.schedule.listWorkerAllocations(client, serviceId, outgoingWorkerId, from);
      if (own.length === 0) throw new SubstitutionNoShiftsInPeriodError(outgoingWorkerId, from, from);
      // as faixas (horário) das alocações: uma semana a partir de D vê cada dia da semana uma vez
      const inputs = await this.occurrences.readForService(client, patientId, serviceId, from, addDaysToDateString(from, 6));
      const slotById = new Map(inputs.slots.map((sl) => [sl.slotId, sl]));
      const shifts: WorkerShift[] = own.flatMap((a) => {
        const slot = slotById.get(a.slotId);
        return slot ? [{ date: from, slotId: a.slotId, assignmentId: a.id, startTime: slot.startTime, endTime: slot.endTime }] : [];
      });

      const conflicts: ShiftConflict[] = [];
      for (const workerId of [...new Set(candidateWorkerIds)]) {
        for (const shift of shifts) conflicts.push(await this.conflictOf(client, workerId, shift, null));
      }

      const agendado = await this.exit.scheduled.listFor(client, serviceId, outgoingWorkerId, hoje);
      const permanent: PermanentPreview = {
        allocationCount: own.length,
        cancelledAbsences: (await this.exit.absenceOps.listOpenOfWorker(client, serviceId, outgoingWorkerId, from)).length,
        clearedSubstitutes: agendado.substitutions.filter((x) => x.date >= from).length,
        pendingEntry: agendado.futureEntries.length > 0,
      };
      return { shifts, conflicts, statusAfter: await this.permanentStatusAfter(client, patientId, serviceId, outgoingWorkerId, from, hoje, now), permanent };
    });
  }

  /** O estado hoje × o estado a partir de D SEM as alocações dela no serviço (ninguém entra): a mesma conta, faixas ajustadas. */
  private async permanentStatusAfter(client: PoolClient, patientId: string, serviceId: string, workerId: string, from: string, hoje: string, now: Date): Promise<SubstitutionStatusAfter | null> {
    const current = await this.derivation.evaluate(client, patientId, now, { lock: false });
    if (current === null) return null;
    const transform = (rows: KanbanServicesRows): KanbanServicesRows => ({
      ...rows,
      slots: rows.slots.map((r) => {
        if (r.contractedServiceId !== serviceId || r.workerId !== workerId || r.status !== 'ACTIVE') return r;
        return r.validFrom !== null && r.validFrom >= from ? { ...r, status: 'CANCELLED' as const } : { ...r, validTo: addDaysToDateString(from, -1) };
      }),
    });
    const simulated = await this.derivation.evaluate(client, patientId, now, { lock: false, simulate: { asOf: from > hoje ? from : hoje, transform } });
    if (simulated === null) return null;
    const before = derivarEstadoPaciente(current.input);
    const after = derivarEstadoPaciente(simulated.input);
    return { current: current.subject.status, after: after ?? current.subject.status, changes: after !== before };
  }

  private async executeDays(input: PreviewSubstitutionRequestInput): Promise<PreviewSubstitutionRequestResult> {
    const { patientId, serviceId, outgoingWorkerId, from, to, candidateWorkerIds, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      // Lê o serviço sob RLS ANTES de chamar a função DEFINER do banco (ela não tem como saber de quem é o slot).
      const team = await this.team.readWith(client, patientId, serviceId);
      if (team === null) throw new SubstitutionServiceNotFoundError(patientId, serviceId);
      if (from < operationDateOf(team.country, now)) throw new SubstitutionPeriodInPastError(from);

      const inputs = await this.occurrences.readForService(client, patientId, serviceId, from, to);
      const shifts = shiftsOfWorkerInPeriod(inputs.slots, inputs.assignments, outgoingWorkerId, datesBetween(from, to));
      if (shifts.length === 0) throw new SubstitutionNoShiftsInPeriodError(outgoingWorkerId, from, to);

      const conflicts: ShiftConflict[] = [];
      for (const workerId of [...new Set(candidateWorkerIds)]) {
        for (const shift of shifts) {
          conflicts.push(await this.conflictOf(client, workerId, shift, shift.date));
        }
      }

      return { shifts, conflicts, statusAfter: await this.statusAfter(client, patientId, now) };
    });
  }

  /** `to = null` = vigência aberta ("No vuelve más" com substituto). */
  private async conflictOf(client: PoolClient, workerId: string, shift: WorkerShift, to: string | null): Promise<ShiftConflict> {
    const base = { workerId, date: shift.date, slotId: shift.slotId };
    try {
      const overlaps = await this.conflicts.preview(client, { workerId, slotId: shift.slotId, from: shift.date, to });
      return overlaps.length === 0 ? { ...base, state: 'free', overlaps: [] } : { ...base, state: 'conflict', overlaps };
    } catch (err) {
      if (err instanceof ConflictPreviewUnavailableError) return { ...base, state: 'unknown', overlaps: [] };
      throw err;
    }
  }

  /** Falta temporária não retira cobertura estrutural (spec §4): a MESMA regra pura, com as mesmas coberturas antes e depois. */
  private async statusAfter(client: PoolClient, patientId: string, now: Date): Promise<SubstitutionStatusAfter | null> {
    const evaluation = await this.derivation.evaluate(client, patientId, now, { lock: false });
    if (evaluation === null) return null;
    const before = derivarEstadoPaciente(evaluation.input);
    const after = derivarEstadoPaciente({ ...evaluation.input, servicos: evaluation.input.servicos });
    return { current: evaluation.subject.status, after: after ?? evaluation.subject.status, changes: after !== before };
  }
}
