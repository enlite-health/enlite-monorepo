/**
 * SubstituteConflictPreviewReader — a pré-visão do conflito do substituto (spec 069, FR-15, migration 548 §2.4). Chama
 * `itinerary_substitute_conflict_preview(worker, slot, from, to, ignoreAbsence)`: a MESMA montagem do gatilho da ausência
 * (`itinerary_slot_worker_conflict`), DEFINER, que devolve só dia/hora/duração e "mesmo endereço" — nenhum id de serviço ou
 * paciente alheio. Nunca reimplementa a regra de conflito em TS.
 *
 * Cada chamada roda num SAVEPOINT: se a função falhar, o `ROLLBACK TO` mantém a transação viva e o chamador marca o par como
 * `unknown` ("no se pudo verificar") — falha nunca vira "sem conflito". O caso de uso lê o slot sob RLS ANTES de chamar.
 */
import type { PoolClient } from 'pg';

export interface ConflictOverlap {
  weekday: number;
  startTime: string;
  durationMinutes: number;
  sameAddress: boolean;
}

export interface ConflictPreviewInput {
  workerId: string;
  slotId: string;
  from: string;
  /** `null` = vigência aberta ("No vuelve más" com substituto). */
  to: string | null;
  /** A própria ausência, quando se escolhe quem entra numa que já existe (senão ela colide consigo mesma). */
  ignoreAbsenceId?: string | null;
}

/** A função do banco falhou: o par fica `unknown`, nunca `free`. */
export class ConflictPreviewUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('substitute conflict preview unavailable');
    this.name = 'ConflictPreviewUnavailableError';
  }
}

interface PreviewRow {
  weekday: number;
  start_time: string;
  duration_minutes: number;
  same_address: boolean;
}

export class SubstituteConflictPreviewReader {
  async preview(client: PoolClient, input: ConflictPreviewInput): Promise<ConflictOverlap[]> {
    await client.query('SAVEPOINT conflict_preview');
    try {
      const res = await client.query<PreviewRow>(
        `SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, duration_minutes, same_address
           FROM itinerary_substitute_conflict_preview($1::uuid, $2::uuid, $3::date, $4::date, $5::uuid)`,
        [input.workerId, input.slotId, input.from, input.to, input.ignoreAbsenceId ?? null],
      );
      await client.query('RELEASE SAVEPOINT conflict_preview');
      return res.rows.map((r) => ({ weekday: r.weekday, startTime: r.start_time, durationMinutes: r.duration_minutes, sameAddress: r.same_address }));
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT conflict_preview');
      throw new ConflictPreviewUnavailableError(err);
    }
  }
}
