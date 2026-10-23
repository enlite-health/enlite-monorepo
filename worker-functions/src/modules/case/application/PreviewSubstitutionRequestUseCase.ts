/**
 * PreviewSubstitutionRequestUseCase — spec 069, FR-15/US4/US5: a pré-visão do pedido. LEITURA pura (nunca escreve; o lock do
 * paciente da derivação fica de fora). Mesma entrada do create, sem os substitutos escolhidos; devolve:
 *  - os turnos da pessoa no período (data, faixa, início, fim) — o que a tela mostra no passo 2, nunca calculado no front;
 *  - o conflito TRI-ESTADO de cada candidato × turno, vindo de `itinerary_substitute_conflict_preview` (a MESMA montagem do
 *    gatilho da ausência): `free` · `conflict` · `unknown` (a função falhou — "no se pudo verificar"; falha nunca vira `free`);
 *  - o estado do paciente depois do pedido (`derivarEstadoPaciente`, a MESMA regra): falta temporária não move o estado, então
 *    `changes` é `false` por construção do pedido de dias; o "No vuelve más" completa isto na F3.
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

export interface ConflictPreviewPort {
  preview(client: PoolClient, input: ConflictPreviewInput): Promise<ConflictOverlap[]>;
}
export interface StatusEvaluationPort {
  evaluate(client: PoolClient, patientId: string, now: Date, opts: { lock: boolean }): Promise<DerivationEvaluation | null>;
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
}

export class PreviewSubstitutionRequestUseCase {
  constructor(
    private readonly team: CreateSubstitutionTeamPort = new ServiceTeamReader(),
    private readonly occurrences: CreateSubstitutionOccurrencesPort = { readForService: readServiceOccurrenceInputs },
    private readonly conflicts: ConflictPreviewPort = new SubstituteConflictPreviewReader(),
    private readonly derivation: StatusEvaluationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: PreviewSubstitutionRequestInput): Promise<PreviewSubstitutionRequestResult> {
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
          conflicts.push(await this.conflictOf(client, workerId, shift));
        }
      }

      return { shifts, conflicts, statusAfter: await this.statusAfter(client, patientId, now) };
    });
  }

  private async conflictOf(client: PoolClient, workerId: string, shift: WorkerShift): Promise<ShiftConflict> {
    const base = { workerId, date: shift.date, slotId: shift.slotId };
    try {
      const overlaps = await this.conflicts.preview(client, { workerId, slotId: shift.slotId, from: shift.date, to: shift.date });
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
