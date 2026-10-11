import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { ConclusiveExtensionState, ExtensionState } from '../domain/chromeExtensionState';

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface ChromeReportRow {
  host_email: string;
  state: ExtensionState;
  report_at: Date | null;
  conclusive_state: ConclusiveExtensionState | null;
  state_changed_at: Date;
  checked_at: Date;
}

/**
 * ChromeReportRepository — SQL do estado da extensão (`admission_chrome_reports`, 516) e da trilha `tactiq_extension.*`
 * (`admission_events`). O relógio entra por parâmetro. Só e-mail do roster, estado e datas: nada de id de perfil nem de dispositivo.
 */
export class ChromeReportRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async listActiveRosterEmails(ex: Db = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ email: string }>(`SELECT email FROM interview_hosts WHERE active = true ORDER BY email`);
    return rows.map((r) => r.email);
  }

  async findByEmail(email: string, ex: Db = this.db): Promise<ChromeReportRow | null> {
    const { rows } = await ex.query<ChromeReportRow>(
      `SELECT host_email, state, report_at, conclusive_state, state_changed_at, checked_at
         FROM admission_chrome_reports WHERE lower(host_email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }

  /** Dono ativo do e-mail: quem recebe o sino. `null` = operadora sem usuário (não há sino). */
  async activeUserUidByEmail(email: string, ex: Db = this.db): Promise<string | null> {
    const { rows } = await ex.query<{ firebase_uid: string }>(
      `SELECT firebase_uid FROM users WHERE lower(email) = lower($1) AND is_active IS TRUE ORDER BY created_at LIMIT 1`,
      [email],
    );
    return rows[0]?.firebase_uid ?? null;
  }

  /** Serializa duas execuções simultâneas para a mesma pessoa até o fim da transação (quem perde a corrida lê o estado já gravado). */
  async lockHost(email: string, ex: Db): Promise<void> {
    await ex.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`chrome_report:${email.toLowerCase()}`]);
  }

  /**
   * Grava o veredito. `conclusive_state` só anda quando o veredito é conclusivo; `state_changed_at` só quando o `state` muda.
   * `sem_relatorio` nunca apaga o último estado conclusivo.
   */
  async upsert(
    input: { email: string; state: ExtensionState; reportAt: Date | null; conclusive: ConclusiveExtensionState | null; now: Date },
    ex: Db = this.db,
  ): Promise<void> {
    await ex.query(
      `INSERT INTO admission_chrome_reports (host_email, state, report_at, conclusive_state, state_changed_at, checked_at)
       VALUES (lower($1), $2, $3, $4, $5, $5)
       ON CONFLICT (lower(host_email)) DO UPDATE SET
         state = EXCLUDED.state,
         report_at = EXCLUDED.report_at,
         conclusive_state = COALESCE(EXCLUDED.conclusive_state, admission_chrome_reports.conclusive_state),
         state_changed_at = CASE WHEN admission_chrome_reports.state IS DISTINCT FROM EXCLUDED.state
                                 THEN EXCLUDED.state_changed_at ELSE admission_chrome_reports.state_changed_at END,
         checked_at = EXCLUDED.checked_at`,
      [input.email, input.state, input.reportAt, input.conclusive, input.now],
    );
  }

  /** Evento de transição (`tactiq_extension.*`). A data do relatório vai em `ref` (só instante). */
  async appendEvent(
    event: { email: string; kind: string; outcome: string; reportAt: Date | null; at: Date },
    ex: Db = this.db,
  ): Promise<void> {
    await ex.query(
      `INSERT INTO admission_events (host_email, kind, outcome, ref, at) VALUES (lower($1), $2, $3, $4::jsonb, $5)`,
      [event.email, event.kind, event.outcome, JSON.stringify({ reportAt: event.reportAt ? event.reportAt.toISOString() : null }), event.at],
    );
  }
}
