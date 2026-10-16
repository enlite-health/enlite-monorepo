import type { Pool, PoolClient } from 'pg';
import type { SummaryFastState } from '../domain/admissionLive';

type Ex = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** A linha da reunião com o gatilho do resumo armado, travada pelo job de 1 min. */
export interface ArmedSummary {
  id: string;
  conference_ended_at: Date | null;
  import_status: string | null;
  summary_fast_reads: number | null;
  summary_fast_last_count: number | null;
  summary_fast_last_read_at: Date | null;
}

/**
 * Estado do gatilho do resumo (colunas `summary_fast_*`, migration 517). Só a F28 escreve aqui, sempre em transação CURTA, nunca com
 * chamada externa aberta. A leitura é REIVINDICADA na linha (`summary_fast_last_read_at`) antes de sair da transação: a execução
 * seguinte (ou a sobreposta) lê o carimbo, vê o intervalo de 60 s e espera.
 */
export class AdmissionFastSummaryRepository {
  /** A mesma trava de linha do job de 15 min (`FOR UPDATE OF a SKIP LOCKED`): quem não a consegue recebe `null`. */
  async lockArmed(id: string, ex: Ex): Promise<ArmedSummary | null> {
    const { rows } = await ex.query<ArmedSummary>(
      `SELECT a.id, a.conference_ended_at, a.import_status, a.summary_fast_reads, a.summary_fast_last_count, a.summary_fast_last_read_at
         FROM admission_appointments a
        WHERE a.id = $1 AND a.status = 'booked' AND a.summary_fast_state = 'armed'
          FOR UPDATE OF a SKIP LOCKED`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Reivindica a leitura: o carimbo é `now`. A contagem de leituras só sobe depois, quando a leitura de fato aconteceu. */
  async claimRead(id: string, now: Date, ex: Ex): Promise<void> {
    await ex.query(`UPDATE admission_appointments SET summary_fast_last_read_at = $2, updated_at = NOW() WHERE id = $1`, [id, now]);
  }

  /** Devolve a reivindicação (a leitura não aconteceu: responsável ocupada, reunião travada por outra importação, token adiado). */
  async releaseRead(id: string, previous: Date | null, ex: Ex): Promise<void> {
    await ex.query(`UPDATE admission_appointments SET summary_fast_last_read_at = $2, updated_at = NOW() WHERE id = $1`, [id, previous]);
  }

  /** A leitura aconteceu e a transcrição não está pronta: +1 leitura e a contagem vista (`null` = não leu / não apareceu). */
  async recordRead(id: string, count: number | null, ex: Ex): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments SET summary_fast_reads = COALESCE(summary_fast_reads, 0) + 1, summary_fast_last_count = $2, updated_at = NOW() WHERE id = $1`,
      [id, count],
    );
  }

  /** Fecha o gatilho (`fired` | `gave_up` | `cancelled`). `read`: a leitura que terminou o gatilho também conta (+1 e a contagem vista). */
  async finish(id: string, state: Exclude<SummaryFastState, 'armed'>, ex: Ex, read?: { count: number | null }): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments
          SET summary_fast_state = $2,
              summary_fast_reads = COALESCE(summary_fast_reads, 0) + $3::int,
              summary_fast_last_count = CASE WHEN $3::int = 1 THEN $4::int ELSE summary_fast_last_count END,
              updated_at = NOW()
        WHERE id = $1`,
      [id, state, read ? 1 : 0, read?.count ?? null],
    );
  }
}
