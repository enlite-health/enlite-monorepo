/**
 * UndoSubstitutionRequestUseCase — spec 069, FR-21/FR-22/FR-33 (US7): desfazer um pedido de substituição, UMA transação.
 *
 * A decisão "ainda dá para desfazer?" é a de `describeRequest` (`undoable`): pedido já desfeito = 409 `REQUEST_ALREADY_UNDONE`;
 * nada futuro a desfazer (dias todos passados; permanente a partir de hoje) = 409 `REQUEST_NOT_UNDOABLE`. Nunca DELETE.
 *  - DIAS: cancela as ausências do pedido com `on_date ≥ hoje` (dias passados intocados) → `undone_at/by`. O banco recusa o carimbo
 *    se ainda sobrar ausência viva de hoje em diante (23514 `pisr_desfazer_com_turno_aberto`) → o MESMO 409.
 *  - PERMANENTE (antes de D): ORDEM de `RemoveFromItineraryUseCase` — 1º cancela as entradas dos substitutos que começam em D
 *    (`cancelAllocation`), DEPOIS solta o fim do titular (`clearScheduledEnd`, se `valid_to = D−1`) ou o restaura (`restoreCancelled`,
 *    se ele estava `CANCELLED` por só começar em D). Soltar o fim ANTES deixaria os dois vigentes e a Trava A recusaria. A restauração
 *    que bater em `uq_pia_open_pair` vira 409 `ALLOCATION_RESTORE_CONFLICT` (defeito 17), nunca 500.
 * As faltas canceladas pelo FR-23 NÃO voltam (US7). A derivação do estado roda por ÚLTIMO.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { SubstitutionRequestReader } from '../infrastructure/SubstitutionRequestReader';
import { SubstitutionRequestWriter } from '../infrastructure/SubstitutionRequestWriter';
import { ItineraryAbsenceWriter } from '../infrastructure/ItineraryAbsenceWriter';
import { ItineraryAllocationWriter, type AllocationRow } from '../infrastructure/ItineraryAllocationWriter';
import { addDaysToDateString } from '../domain/itineraryEvents';
import type { SubstitutionRequestType } from '../domain/substitutionRequest';
import { reopenErrorFrom, restoreTitular } from './restoreTitular';
import { exitSinceOf, loadRequest, type SubstitutionRequestReaderPort } from './substitutionRequestLoad';
import { SubstitutionRequestAlreadyUndoneError, SubstitutionRequestNotUndoableError } from './substitutionRequestErrors';

export interface UndoRequestsPort {
  markUndone(client: PoolClient, id: string, actorUid: string): Promise<number>;
}
export interface UndoAbsencesPort {
  cancelAbsence(client: PoolClient, id: string, actorUid: string): Promise<number>;
}
export interface UndoSchedulePort {
  findAllocation(client: PoolClient, patientId: string, serviceId: string, allocationId: string): Promise<AllocationRow | null>;
  cancelAllocation(client: PoolClient, id: string, minValidFrom: string, actorUid: string): Promise<number>;
  clearScheduledEnd(client: PoolClient, id: string, actorUid: string): Promise<number>;
  restoreCancelled(client: PoolClient, id: string, minValidFrom: string, actorUid: string): Promise<number>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface UndoSubstitutionRequestInput {
  patientId: string;
  serviceId: string;
  requestId: string;
  actorUid: string;
  now?: Date;
}

export interface UndoSubstitutionRequestResult {
  requestId: string;
  type: SubstitutionRequestType;
  /** Dias: ausências canceladas. */
  cancelledAbsences: number;
  /** Permanente: entradas canceladas / titulares reabertos. */
  cancelledEntries: number;
  restoredTitulars: number;
}

/** `pisr_desfazer_com_turno_aberto` (23514): o banco achou ausência viva de hoje em diante ao carimbar o desfeito. */
function isOpenTurnRefusal(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23514' && e.message === 'pisr_desfazer_com_turno_aberto';
}

export class UndoSubstitutionRequestUseCase {
  constructor(
    private readonly reader: SubstitutionRequestReaderPort = new SubstitutionRequestReader(),
    private readonly requests: UndoRequestsPort = new SubstitutionRequestWriter(),
    private readonly absences: UndoAbsencesPort = new ItineraryAbsenceWriter(),
    private readonly schedule: UndoSchedulePort = new ItineraryAllocationWriter(),
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async execute(input: UndoSubstitutionRequestInput): Promise<UndoSubstitutionRequestResult> {
    const { patientId, serviceId, requestId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const { view, hoje, absences, logRows } = await loadRequest(this.reader, client, { patientId, serviceId, requestId }, now);
      if (!view.undoable) throw new SubstitutionRequestNotUndoableError(requestId);

      let cancelledAbsences = 0;
      let cancelledEntries = 0;
      let restoredTitulars = 0;

      if (view.type === 'PERMANENT') {
        const exits = logRows.filter((r) => (r.kind === 'REPLACE' || r.kind === 'REMOVE') && r.assignmentId !== null);
        const sinceByTitular = new Map<string, string>();
        for (const row of exits) {
          const id = row.assignmentId as string;
          const since = exitSinceOf(row);
          const current = sinceByTitular.get(id);
          if (current === undefined || since < current) sinceByTitular.set(id, since);
        }
        const firstDay = [...sinceByTitular.values()].sort()[0];
        // (1) PRIMEIRO as entradas dos substitutos (que começam em D) — ORDEM obrigatória (Trava A)
        for (const entryId of new Set(exits.flatMap((r) => (r.newAssignmentId ? [r.newAssignmentId] : [])))) {
          if ((await this.schedule.cancelAllocation(client, entryId, firstDay, actorUid)) > 0) cancelledEntries += 1;
        }
        // (2) DEPOIS o titular volta: solta o fim agendado (D−1) ou restaura o que estava CANCELLED
        for (const [titularId, since] of sinceByTitular) {
          const titular = await this.schedule.findAllocation(client, patientId, serviceId, titularId);
          if (titular === null) continue;
          if (titular.status === 'CANCELLED') {
            await restoreTitular(this.schedule, client, titularId, since, actorUid);
            restoredTitulars += 1;
          } else if (titular.status === 'ACTIVE' && titular.validTo === addDaysToDateString(since, -1)) {
            try {
              await this.schedule.clearScheduledEnd(client, titularId, actorUid);
            } catch (err) {
              throw reopenErrorFrom(err, titularId) ?? err; // soltar o fim reabre o par: a mesma barreira (409), nunca 500
            }
            restoredTitulars += 1;
          }
        }
      } else {
        for (const absence of absences.filter((a) => a.cancelledAt === null && a.onDate >= hoje)) {
          if ((await this.absences.cancelAbsence(client, absence.absenceId, actorUid)) > 0) cancelledAbsences += 1;
        }
      }

      try {
        if ((await this.requests.markUndone(client, requestId, actorUid)) === 0) throw new SubstitutionRequestAlreadyUndoneError(requestId);
      } catch (err) {
        if (isOpenTurnRefusal(err)) throw new SubstitutionRequestNotUndoableError(requestId);
        throw err;
      }

      await this.derivation.run(client, patientId, now);
      return { requestId, type: view.type, cancelledAbsences, cancelledEntries, restoredTitulars };
    });
  }
}
