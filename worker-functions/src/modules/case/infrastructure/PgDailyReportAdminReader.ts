/**
 * PgDailyReportAdminReader — leitura do painel dos informes de UM paciente (spec 092, CA-4).
 *
 * Sempre por `withActorContext` (RLS de país: paciente de outro país é 404, nunca vazamento). O paciente do informe DERIVA de
 * faixa → serviço → paciente (D514/D516: não é coluna). O texto (`narrative`) só entra no SELECT quando `withNarrative` — sem a célula
 * ele nem é lido do banco (minimização). Nada aqui loga linha nem resposta.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { AdminReportAnswerRow, AdminReportRow, DailyReportAdminPort } from '../application/ports/DailyReportAdminPort';

/** Teto de linhas por leitura (sem janela informada): o painel pagina por data; ninguém lê o histórico inteiro de uma vez. */
export const ADMIN_REPORTS_LIMIT = 366;
const OPERATION_TZ = 'America/Argentina/Buenos_Aires';

interface ReportRow {
  id: string;
  worker_id: string;
  on_date: string;
  pti_version_id: string | null;
  narrative_source: AdminReportRow['narrativeSource'];
  device_submitted_at: Date;
  received_at: Date;
  app_version: string;
  guard_ends_at: Date;
  narrative: string | null;
}

interface AnswerRow {
  report_id: string;
  objective_id: string | null;
  activity_id: string | null;
  item_title: string | null;
  scale_code: string;
  option_code: string | null;
  count_value: number | null;
  reason_code: string | null;
  score: number | null;
  immediate_alert: boolean;
}

export class PgDailyReportAdminReader implements DailyReportAdminPort {
  private poolMemo?: Pool;

  constructor(pool?: Pool) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  listForPatient(args: { patientId: string; from: string | null; to: string | null; withNarrative: boolean }): Promise<AdminReportRow[] | null> {
    return withActorContext(this.pool, async (client) => {
      const exists = await client.query('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [args.patientId]);
      if (exists.rowCount === 0) return null;
      const reports = await client.query<ReportRow>(
        `SELECT r.id, r.worker_id, to_char(r.on_date, 'YYYY-MM-DD') AS on_date, r.pti_version_id, r.narrative_source, r.device_submitted_at,
                r.received_at, r.app_version,
                ((r.on_date + s.start_time + make_interval(mins => s.duration_minutes)) AT TIME ZONE '${OPERATION_TZ}') AS guard_ends_at,
                CASE WHEN $4::boolean THEN r.narrative END AS narrative
           FROM daily_reports r
           JOIN patient_itinerary_slot s ON s.id = r.slot_id
           JOIN patient_contracted_services c ON c.id = s.contracted_service_id
          WHERE c.patient_id = $1
            AND ($2::date IS NULL OR r.on_date >= $2::date)
            AND ($3::date IS NULL OR r.on_date <= $3::date)
          ORDER BY r.on_date DESC, r.received_at DESC, r.id
          LIMIT ${ADMIN_REPORTS_LIMIT}`,
        [args.patientId, args.from, args.to, args.withNarrative],
      );
      if (reports.rows.length === 0) return [];
      const answers = await client.query<AnswerRow>(
        `SELECT a.report_id, a.objective_id, a.activity_id, COALESCE(o.label, ac.label) AS item_title, a.scale_code, a.option_code, a.count_value,
                a.reason_code, sc.score, (sg.report_id IS NOT NULL) AS immediate_alert
           FROM daily_report_answers a
           LEFT JOIN therapeutic_specific_objectives o ON o.id = a.objective_id
           LEFT JOIN therapeutic_activities ac ON ac.id = a.activity_id
           LEFT JOIN daily_report_answer_scores sc
                  ON sc.report_id = a.report_id AND sc.scale_code = a.scale_code
                 AND sc.objective_id IS NOT DISTINCT FROM a.objective_id AND sc.activity_id IS NOT DISTINCT FROM a.activity_id
           LEFT JOIN daily_report_alert_signals sg
                  ON sg.report_id = a.report_id AND sg.scale_code = a.scale_code
                 AND sg.objective_id IS NOT DISTINCT FROM a.objective_id AND sg.activity_id IS NOT DISTINCT FROM a.activity_id
          WHERE a.report_id = ANY($1::uuid[])
          ORDER BY a.report_id, a.objective_id NULLS LAST, a.activity_id NULLS LAST`,
        [reports.rows.map((r) => r.id)],
      );
      const byReport = new Map<string, AdminReportAnswerRow[]>();
      for (const a of answers.rows) {
        const list = byReport.get(a.report_id) ?? [];
        list.push({
          itemKind: a.objective_id ? 'objective' : 'activity',
          itemId: (a.objective_id ?? a.activity_id) as string,
          itemTitle: a.item_title ?? '',
          scaleCode: a.scale_code,
          optionCode: a.option_code,
          countValue: a.count_value,
          reasonCode: a.reason_code,
          score: a.score,
          immediateAlert: a.immediate_alert,
        });
        byReport.set(a.report_id, list);
      }
      return reports.rows.map((r) => ({
        id: r.id,
        workerId: r.worker_id,
        onDate: r.on_date,
        ptiVersionId: r.pti_version_id,
        narrativeSource: r.narrative_source,
        deviceSubmittedAt: r.device_submitted_at,
        receivedAt: r.received_at,
        appVersion: r.app_version,
        guardEndsAt: r.guard_ends_at,
        narrative: r.narrative,
        answers: byReport.get(r.id) ?? [],
      }));
    });
  }
}
