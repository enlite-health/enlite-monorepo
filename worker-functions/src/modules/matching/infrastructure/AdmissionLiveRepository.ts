import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { POST_CALL_WINDOW_HOURS } from '../domain/admissionPostCall';
import { LIVE_ENTRY_LEAD_MS, LIVE_EXIT_TAIL_MS } from '../domain/admissionLive';

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

export class AdmissionLiveRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async listActiveIds(now: Date, limit = 200, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id FROM admission_appointments a WHERE ${ACTIVE} ORDER BY a.slot_start, a.id LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }
}
