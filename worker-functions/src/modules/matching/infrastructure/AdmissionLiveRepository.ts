import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { POST_CALL_WINDOW_HOURS } from '../domain/admissionPostCall';
import { LIVE_ENTRY_LEAD_MS, LIVE_EXIT_TAIL_MS, type SummaryFastState } from '../domain/admissionLive';
import { rehearsalUntilSql } from './admissionRehearsalSql';
import type { PostCallCandidate } from './AdmissionPostCallRepository';

type Ex = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * Fila do job de 1 minuto (spec 050, 4º passo; R-46, R-47): UMA consulta numa tabela só. Entra a reunião `booked` com código ADM que
 *  (a) está na janela ativa: de `slot_start − 15 min` até `slot_end + 60 min` (bordas incluídas), OU
 *  (b) tem conferência aberta observada (início gravado, sem fim, fim marcado há menos de 72 h = `POST_CALL_WINDOW_HOURS`), OU
 *  (c) tem o gatilho do resumo `armed`.
 * `cancelled`, `no_show` e sem código ficam fora (`status` ≠ `booked` ou `admission_code` nulo). O relógio entra por parâmetro.
 */
const ACTIVE = `
  a.status = 'booked'
  AND a.admission_code IS NOT NULL
  AND (
    (a.slot_start - make_interval(secs => ${LIVE_ENTRY_LEAD_MS / 1000}) <= $1
       AND a.slot_end + make_interval(secs => ${LIVE_EXIT_TAIL_MS / 1000}) >= $1)
    OR (a.conference_started_at IS NOT NULL AND a.conference_ended_at IS NULL
        AND a.slot_end >= $1::timestamptz - make_interval(hours => ${POST_CALL_WINDOW_HOURS}))
    OR a.summary_fast_state = 'armed'
  )`;

/** A reunião travada pelo job de 1 min: o que o job de 15 min lê (`PostCallCandidate`) mais o estado que só o de 1 min decide por. */
export interface LiveCandidate extends PostCallCandidate {
  conference_ended_at: Date | null;
  summary_fast_state: SummaryFastState | null;
  /** Já existe o evento `conference_reopened` com `reason='after_summary'` (o evento é UM por reunião). */
  reopen_after_summary_recorded: boolean;
}

export class AdmissionLiveRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async listActiveIds(now: Date, limit = 200, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id FROM admission_appointments a WHERE ${ACTIVE} ORDER BY a.slot_start, a.id LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  /**
   * A trava da reunião (a MESMA do job de 15 min: `FOR UPDATE OF a SKIP LOCKED`), mas com a fila DESTE job (`ACTIVE`). Quem não a
   * consegue (outra execução com ela) recebe `null`. Devolve também o estado que `decideLive` precisa.
   */
  async lockActive(id: string, now: Date, ex: Ex): Promise<LiveCandidate | null> {
    const { rows } = await ex.query<LiveCandidate>(
      `SELECT a.id, a.host_email, a.meet_link, a.meet_space_name, a.slot_start, a.slot_end, a.conference_started_at,
              a.conference_ended_at, a.import_status, a.summary_fast_state,
              p.is_test IS TRUE AS patient_is_test, ${rehearsalUntilSql('a')} AS rehearsal_until,
              EXISTS (SELECT 1 FROM admission_events e WHERE e.appointment_id = a.id AND e.kind = 'conference_reopened' AND e.reason = 'after_summary')
                AS reopen_after_summary_recorded
         FROM admission_appointments a
         JOIN patients p ON p.id = a.patient_id
        WHERE a.id = $2 AND ${ACTIVE}
          FOR UPDATE OF a SKIP LOCKED`,
      [now, id],
    );
    return rows[0] ?? null;
  }

  /**
   * Há importação em voo nesta reunião? A importação segura `pg_advisory_lock(hashtextextended('admission_import:<id>', 0))` na sessão
   * (`AdmissionImportService.importOne`). Aqui tenta-se a MESMA chave, de transação: se não vier, a importação está em voo e quem chama
   * não mexe. Quando vem, a trava dura até o fim da transação e a importação que chegar pula como `skipped_locked`.
   */
  async importInFlight(id: string, ex: Ex): Promise<boolean> {
    const { rows } = await ex.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [`admission_import:${id}`]);
    return !rows[0]?.ok;
  }

  /** R-45: ARMA o gatilho do resumo. Recomeça: zera a última contagem e a última leitura (o nº de leituras NÃO zera: o teto é por reunião). */
  async armSummaryTrigger(id: string, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments SET summary_fast_state = 'armed', summary_fast_last_count = NULL, summary_fast_last_read_at = NULL, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  /**
   * R-49: a conferência reabriu antes do resumo. Zera o fim (e o "ficou sabendo" dele), devolve `pending` a vazio (sem fim não há o que
   * importar; `waiting|blocked` ficam como estão) e CANCELA o gatilho se estava armado.
   */
  async reopenConference(id: string, cancelTrigger: boolean, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments
          SET conference_ended_at = NULL, conference_end_seen_at = NULL,
              import_status = CASE WHEN import_status = 'pending' THEN NULL ELSE import_status END,
              summary_fast_state = CASE WHEN $2::boolean THEN 'cancelled' ELSE summary_fast_state END,
              updated_at = NOW()
        WHERE id = $1`,
      [id, cancelTrigger],
    );
  }
}
