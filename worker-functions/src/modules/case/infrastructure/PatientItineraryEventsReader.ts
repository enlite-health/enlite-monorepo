/**
 * PatientItineraryEventsReader — leitura crua para a agenda "Próximos días" (D445.3 → spec 069, FR-12). Roda inteiro em
 * `inPatientTransaction` (RLS de país), datas/horas saem como TEXTO (`to_char` — nunca `Date` do driver). O que alimenta a
 * expansão (faixas que tocam o intervalo, alocações ACTIVE, ausências vivas) vem de `occurrenceInputs.ts`, a MESMA leitura do
 * cartão do serviço e do Kanban; aqui só se acrescenta a fonte CIFRADA do nome de cada worker distinto (titular + substituto).
 *
 * Nome de prestador NÃO sai daqui decifrado — quem decifra é o caso de uso (`GetPatientItineraryEventsUseCase`), com a célula,
 * como o GET do itinerário (DX-12.5).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import { readOccurrenceInputsByPatient, EMPTY_OCCURRENCE_INPUTS, type OccurrenceInputs } from './occurrenceInputs';

/** Fonte cifrada do nome de um worker (titular ou substituto) — mesma forma de `WorkerNameSource`. */
export interface ItineraryEventWorkerNameRow {
  workerId: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export interface ItineraryEventsRows extends OccurrenceInputs {
  country: string;
  /** Fonte cifrada do nome de cada worker distinto (titular + substituto) que aparece no intervalo. */
  workerNames: ItineraryEventWorkerNameRow[];
}

interface PatientCountryRow {
  id: string;
  country: string;
}

interface WorkerNameJoinRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

export class PatientItineraryEventsReader {
  /** `null` = paciente inexistente/soft-deletado/outro país (RLS) — o caso de uso mapeia para 404. */
  async readForRange(patientId: string, from: string, to: string): Promise<ItineraryEventsRows | null> {
    return inPatientTransaction((client) => this.run(client, patientId, from, to));
  }

  private async run(client: PoolClient, patientId: string, from: string, to: string): Promise<ItineraryEventsRows | null> {
    const patientRes = await client.query<PatientCountryRow>(
      `SELECT id, country FROM patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if ((patientRes.rowCount ?? 0) === 0) return null;
    const { country } = patientRes.rows[0];

    const inputs =
      (
        await readOccurrenceInputsByPatient(client, {
          scopeSql: 'pcs.patient_id = $1 AND pcs.active',
          fromSql: '$2::date',
          toSql: '$3::date',
          params: [patientId, from, to],
        })
      ).get(patientId) ?? EMPTY_OCCURRENCE_INPUTS;

    const workerIds = new Set<string>();
    for (const a of inputs.assignments) workerIds.add(a.workerId);
    for (const ab of inputs.absences) if (ab.substituteWorkerId) workerIds.add(ab.substituteWorkerId);

    const namesRes =
      workerIds.size === 0
        ? { rows: [] as WorkerNameJoinRow[] }
        : await client.query<WorkerNameJoinRow>(
            `SELECT id, first_name_encrypted, last_name_encrypted FROM workers WHERE id = ANY($1::uuid[])`,
            [[...workerIds]],
          );
    const encrypted = new Map(namesRes.rows.map((r) => [r.id, r]));

    return {
      country,
      slots: inputs.slots,
      assignments: inputs.assignments,
      absences: inputs.absences,
      workerNames: [...workerIds].map((workerId) => ({
        workerId,
        firstNameEncrypted: encrypted.get(workerId)?.first_name_encrypted ?? null,
        lastNameEncrypted: encrypted.get(workerId)?.last_name_encrypted ?? null,
      })),
    };
  }
}
