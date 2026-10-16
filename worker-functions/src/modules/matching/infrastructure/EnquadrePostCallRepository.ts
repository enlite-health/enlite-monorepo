import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { POST_CALL_WINDOW_HOURS } from '../domain/admissionPostCall';
import { ENQUADRE_POST_CALL_BATCH } from '../domain/enquadreJobConfig';
import type { Ex, PostCallSource, PostCallSubject } from '../application/ports/PostCallPorts';

/**
 * Elegível para o fim de call do enquadre: evento `open` ou `closed` (encerrar o evento na tela NÃO impede de medir a call; o
 * `cancelled` sai) que JÁ COMEÇOU pela hora marcada e cujo fim marcado passou há menos de 72 h, e que não está em estado terminal.
 * O resto é a MESMA regra da admissão (`AdmissionPostCallRepository`): `blocked` volta à fila (o bloqueio some quando o escopo do
 * Meet é liberado); depois do fim real gravado o evento é da IMPORTAÇÃO (`pending|waiting|blocked`); `(conference_ended_at IS NULL
 * OR import_status IS NULL)` cobre o fim gravado sem `pending`. SEM paciente: nada de `JOIN` em `patients`.
 */
const ELIGIBLE = `
  e.status IN ('open', 'closed')
  AND e.starts_at <= $1
  AND e.ends_at >= $1::timestamptz - make_interval(hours => ${POST_CALL_WINDOW_HOURS})
  AND (e.conference_ended_at IS NULL OR e.import_status IS NULL)
  AND (e.import_status IS NULL OR e.import_status IN ('waiting', 'blocked'))`;

/**
 * EnquadrePostCallRepository — a FONTE do fim de call do enquadre (porto `PostCallSource`) sobre `enquadre_events` (spec 052,
 * migrations 518 e 521). Fila com lote próprio (`ENQUADRE_POST_CALL_BATCH`), trava por evento com `FOR UPDATE SKIP LOCKED`
 * (duas execuções sobrepostas não processam o mesmo) e transições de estado. O relógio entra por parâmetro.
 */
export class EnquadrePostCallRepository implements PostCallSource {
  constructor(
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly batchSize: number = ENQUADRE_POST_CALL_BATCH,
  ) {}

  async listCandidateIds(now: Date, limit: number = this.batchSize, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT e.id FROM enquadre_events e WHERE ${ELIGIBLE} ORDER BY e.ends_at LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async lockCandidate(id: string, now: Date, ex: Ex): Promise<PostCallSubject | null> {
    const { rows } = await ex.query<PostCallSubject>(
      `SELECT e.id, e.host_email, e.meet_link, e.meet_space_name, e.starts_at AS slot_start, e.ends_at AS slot_end,
              e.conference_started_at, e.import_status, FALSE AS patient_is_test, NULL::timestamptz AS rehearsal_until
         FROM enquadre_events e
        WHERE e.id = $2 AND ${ELIGIBLE}
          FOR UPDATE OF e SKIP LOCKED`,
      [now, id],
    );
    return rows[0] ?? null;
  }

  async saveSpace(id: string, spaceName: string, ex: Ex): Promise<void> {
    await ex.query(`UPDATE enquadre_events SET meet_space_name = $2 WHERE id = $1`, [id, spaceName]);
  }

  /** Grava o MENOR início observado (nunca anda para frente). `seenAt` não tem coluna no enquadre (sem job "ao vivo"). */
  async markConferenceStarted(id: string, startedAt: Date, _seenAt: Date, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE enquadre_events SET conference_started_at = LEAST(COALESCE(conference_started_at, $2), $2) WHERE id = $1`,
      [id, startedAt],
    );
  }

  /** Fim REAL: o evento passa a ser da importação (`pending`); sai o motivo de um `blocked` anterior (o CHECK da 521 exige). */
  async markConferenceEnded(id: string, endedAt: Date, _seenAt: Date, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE enquadre_events SET conference_ended_at = $2, import_status = 'pending', blocked_reason = NULL WHERE id = $1`,
      [id, endedAt],
    );
  }

  /** Fim cedo demais (só o job "ao vivo" da admissão usa): grava o fim sem `pending`. O enquadre não tem esse job; o porto o exige. */
  async markConferenceEndedEarly(id: string, endedAt: Date, _seenAt: Date, ex: Ex): Promise<void> {
    await ex.query(`UPDATE enquadre_events SET conference_ended_at = $2 WHERE id = $1`, [id, endedAt]);
  }

  async markBlocked(id: string, ex: Ex, reason?: string): Promise<void> {
    await ex.query(`UPDATE enquadre_events SET import_status = 'blocked', blocked_reason = $2 WHERE id = $1`, [id, reason ?? null]);
  }

  /** Ninguém entrou: só o estado da importação (`no_show`); o `status` do evento (open/closed/cancelled) é da tela e não muda. */
  async markNoShow(id: string, ex: Ex): Promise<void> {
    await ex.query(`UPDATE enquadre_events SET import_status = 'no_show', blocked_reason = NULL WHERE id = $1`, [id]);
  }
}
