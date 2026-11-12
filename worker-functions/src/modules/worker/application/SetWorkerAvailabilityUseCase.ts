import { Pool } from 'pg';
import { luzActor } from '@shared/audit/actorSource';
import { resolveActor, withActorContext } from '@shared/database/actorContext';

export interface AvailabilitySlotInput {
  /** 0=Domingo … 6=Sábado. */
  dayOfWeek: number;
  /** "HH:MM" ou "HH:MM:SS" (24h). */
  startTime: string;
  endTime: string;
  timezone?: string;
  crossesMidnight?: boolean;
}

export interface SetWorkerAvailabilityInput {
  workerId: string;
  slots: AvailabilitySlotInput[];
}

export interface SetWorkerAvailabilityResult {
  ok: boolean;
  slots: number;
  reason?: 'empty_slots' | 'invalid_slot' | 'worker_not_found';
}

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * Substitui a disponibilidade estruturada do worker (`worker_availability`) de
 * forma ATÔMICA e AUDITADA. É a fonte da baixa "a Luz registra disponibilidade de
 * verdade" — antes ela só afirmava sem gravar.
 *
 * - SUBSTITUI (delete-all + insert): o prestador declara o estado final, não incremento.
 * - REJEITA lista vazia: nunca deixa o worker sem disponibilidade (protege o status
 *   REGISTERED, que exige worker_availability — migration 208).
 * - Auditado: `app.current_uid` = o ATOR da request (porta MCP do agente: `agent:luz`, spec 078 M2); sem ator na request
 *   (caminho legado, contexto de sistema) segue `luz:set-availability`, como sempre.
 */
export class SetWorkerAvailabilityUseCase {
  constructor(private readonly db: Pool) {}

  async execute(
    input: SetWorkerAvailabilityInput,
  ): Promise<SetWorkerAvailabilityResult> {
    if (!input.slots || input.slots.length === 0) {
      return { ok: false, slots: 0, reason: 'empty_slots' };
    }
    for (const s of input.slots) {
      if (
        !Number.isInteger(s.dayOfWeek) ||
        s.dayOfWeek < 0 ||
        s.dayOfWeek > 6 ||
        !TIME_RE.test(s.startTime) ||
        !TIME_RE.test(s.endTime)
      ) {
        return { ok: false, slots: 0, reason: 'invalid_slot' };
      }
    }

    const exists = await this.db.query(
      `SELECT 1 FROM workers WHERE id = $1 LIMIT 1`,
      [input.workerId],
    );
    if (exists.rows.length === 0) {
      return { ok: false, slots: 0, reason: 'worker_not_found' };
    }

    await withActorContext(
      this.db,
      async (client) => {
        await client.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [input.workerId]);
        for (const s of input.slots) {
          await client.query(
            `INSERT INTO worker_availability
               (worker_id, day_of_week, start_time, end_time, timezone, crosses_midnight)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.workerId, s.dayOfWeek, s.startTime, s.endTime, s.timezone ?? DEFAULT_TZ, s.crossesMidnight ?? false],
          );
        }
      },
      resolveActor() ?? luzActor('set-availability'),
    );

    return { ok: true, slots: input.slots.length };
  }
}
