import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { POST_CALL_WINDOW_HOURS } from '../domain/admissionPostCall';

type Ex = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface PostCallCandidate {
  id: string;
  host_email: string;
  meet_link: string | null;
  meet_space_name: string | null;
  slot_start: Date;
  slot_end: Date;
  import_status: string | null;
}

/** Janela dos detectores de silêncio: o mesmo 72 h do job (sinal de estado não vira ruído eterno sobre reunião antiga). */
export const SILENCE_WINDOW_HOURS = 72;
/** "booked há > 10 min sem linha de confirmação" (spec §5.3). */
export const CONFIRMATION_SILENCE_MINUTES = 10;

/**
 * Elegível para o job: reunião NOVA (tem código ADM — as antigas ficam fora da importação, migration 503), ainda `booked`,
 * cujo fim passou há menos de 72 h e que não está em estado terminal. `blocked` volta à fila: o bloqueio por escopo some
 * quando o H2 é liberado, e a reunião não pode ficar perdida para sempre.
 */
const ELIGIBLE = `
  a.status = 'booked'
  AND a.admission_code IS NOT NULL
  AND a.slot_end < $1
  AND a.slot_end >= $1::timestamptz - make_interval(hours => ${POST_CALL_WINDOW_HOURS})
  AND (a.import_status IS NULL OR a.import_status IN ('waiting', 'blocked'))`;

/**
 * AdmissionPostCallRepository — SQL do job de 15 min (spec 049 F5): candidatas, trava por reunião (`FOR UPDATE SKIP LOCKED`,
 * duas execuções sobrepostas não processam a mesma), transições de estado e as duas consultas dos detectores de silêncio.
 * O relógio entra por parâmetro (`now`).
 */
export class AdmissionPostCallRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async listCandidateIds(now: Date, limit = 200, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id FROM admission_appointments a WHERE ${ELIGIBLE} ORDER BY a.slot_end LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  /** A trava da reunião: quem não a consegue (outra execução com ela) recebe `null` e segue adiante. */
  async lockCandidate(id: string, now: Date, ex: Ex): Promise<PostCallCandidate | null> {
    const { rows } = await ex.query<PostCallCandidate>(
      `SELECT a.id, a.host_email, a.meet_link, a.meet_space_name, a.slot_start, a.slot_end, a.import_status
         FROM admission_appointments a
        WHERE a.id = $2 AND ${ELIGIBLE}
          FOR UPDATE OF a SKIP LOCKED`,
      [now, id],
    );
    return rows[0] ?? null;
  }

  async saveSpace(id: string, spaceName: string, ex: Ex): Promise<void> {
    await ex.query(`UPDATE admission_appointments SET meet_space_name = $2, updated_at = NOW() WHERE id = $1`, [id, spaceName]);
  }

  async markConferenceEnded(id: string, endedAt: Date, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments SET conference_ended_at = $2, import_status = 'pending', updated_at = NOW() WHERE id = $1`,
      [id, endedAt],
    );
  }

  async markBlocked(id: string, ex: Ex): Promise<void> {
    await ex.query(`UPDATE admission_appointments SET import_status = 'blocked', updated_at = NOW() WHERE id = $1`, [id]);
  }

  async markNoShow(id: string, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments SET status = 'no_show', import_status = 'no_show', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Silêncio do lembrete (M7): reunião `booked` NOVA, com consentimento e telefone, de paciente real, que já COMEÇOU e não tem
   * lembrete enviado. "Enviado" = linha `sent|delivered|read` em `admission_messages` (ou o carimbo antigo da 253). Fica de
   * fora quem nunca devia ter lembrete: reunião marcada em cima da hora (`skipped_slot_too_soon`).
   */
  async findReminderSilence(now: Date, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id
         FROM admission_appointments a
         JOIN patients p ON p.id = a.patient_id AND p.deleted_at IS NULL
        WHERE a.status = 'booked'
          AND a.admission_code IS NOT NULL
          AND a.slot_start <= $1
          AND a.slot_start >= $1::timestamptz - make_interval(hours => ${SILENCE_WINDOW_HOURS})
          AND p.is_test IS NOT TRUE
          AND p.has_consent IS TRUE
          AND COALESCE(p.phone_whatsapp, '') <> ''
          AND a.reminder_30min_sent_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM admission_messages m
                           WHERE m.appointment_id = a.id AND m.kind = 'reminder_30min' AND m.status IN ('sent', 'delivered', 'read'))
          AND NOT EXISTS (SELECT 1 FROM admission_events e WHERE e.appointment_id = a.id AND e.kind = 'skipped_slot_too_soon')
        ORDER BY a.slot_start`,
      [now],
    );
    return rows.map((r) => r.id);
  }

  /** Silêncio da confirmação: reunião `booked` NOVA há MAIS de 10 min sem NENHUMA linha de confirmação (nem `skipped_*`). */
  async findConfirmationSilence(now: Date, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id
         FROM admission_appointments a
        WHERE a.status = 'booked'
          AND a.admission_code IS NOT NULL
          AND a.created_at < $1::timestamptz - make_interval(mins => ${CONFIRMATION_SILENCE_MINUTES})
          AND a.created_at >= $1::timestamptz - make_interval(hours => ${SILENCE_WINDOW_HOURS})
          AND NOT EXISTS (SELECT 1 FROM admission_messages m WHERE m.appointment_id = a.id AND m.kind = 'confirmation')
        ORDER BY a.created_at`,
      [now],
    );
    return rows.map((r) => r.id);
  }
}
