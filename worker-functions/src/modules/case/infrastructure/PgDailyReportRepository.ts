/**
 * PgDailyReportRepository — adapter Postgres da porta do informe da guarda (spec 092, F2).
 *
 * Uma transação por chamada de `run`, SEMPRE por `withActorContext` (conexão crua do pool chega sem contexto e a RLS derruba com 500 em prd).
 * A guarda do prestador vem da expansão do itinerário (`readWorkerWindow`, F-5/DC-10): nada de regra reescrita aqui.
 *
 * Privacidade: `narrative` e respostas só passam por parâmetro de query (nunca concatenadas) e NUNCA entram em mensagem de erro nem em log.
 * Erro de constraint do `pg` carrega a LINHA no `detail`: o único erro que sai daqui com significado é `DuplicateReportError` (23505);
 * qualquer outro sobe como está e o controller o reduz a `code`/`constraint` (`toSafeError`) antes de logar.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { readWorkerWindow } from './WorkerItineraryReader';
import {
  DuplicateReportError,
  type DailyReportPort, type DailyReportTx, type GuardOccurrence, type ProjectVersionRef,
} from '../application/ports/DailyReportPort';
import type {
  ActivityRow, ObjectiveRow, ReportAnswer, ReportContent, Scale, ScaleCatalog, ScaleOption, ScaleReason,
} from '../domain/DailyReport';

interface ItemRef { id: string }

interface VersionRow {
  id: string;
  contracted_service_id: string;
  start_date: string;
  end_date: string;
  created_at: Date;
  annulled_at: Date | null;
  specific_objectives: ItemRef[];
  activities: ItemRef[];
}

const VERSION_COLUMNS = `id, contracted_service_id, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
  created_at, annulled_at, specific_objectives, activities`;

const uniqueIds = (items: readonly ItemRef[]): string[] => [...new Set(items.map((i) => i.id))];

function versionRefOf(r: VersionRow): ProjectVersionRef {
  return {
    id: r.id,
    contractedServiceId: r.contracted_service_id,
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: r.created_at.toISOString(),
    annulledAt: r.annulled_at ? r.annulled_at.toISOString() : null,
    objectiveIds: uniqueIds(r.specific_objectives),
    activityIds: uniqueIds(r.activities),
  };
}

class PgDailyReportTx implements DailyReportTx {
  constructor(private readonly client: PoolClient) {}

  async workerIdByUid(uid: string): Promise<string | null> {
    const res = await this.client.query<{ id: string; status: string }>('SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1', [uid]);
    const row = res.rows[0];
    return !row || row.status === 'DISABLED' ? null : row.id;
  }

  async guardsOf(workerId: string, today: string): Promise<GuardOccurrence[]> {
    const envelope = await readWorkerWindow(this.client, { workerId, today });
    if (envelope.items.length === 0) return [];
    const slots = await this.client.query<{ id: string; contracted_service_id: string }>(
      'SELECT id, contracted_service_id FROM patient_itinerary_slot WHERE id = ANY($1::uuid[])',
      [[...new Set(envelope.items.map((i) => i.slot_id))]],
    );
    const serviceOf = new Map(slots.rows.map((s) => [s.id, s.contracted_service_id]));
    return envelope.items.flatMap((i) => {
      const serviceId = serviceOf.get(i.slot_id);
      return serviceId ? [{ occurrenceId: i.occurrence_id, slotId: i.slot_id, serviceId, onDate: i.on_date, endsAt: new Date(i.ends_at) }] : [];
    });
  }

  async scaleCatalog(): Promise<ScaleCatalog> {
    const [scales, options, reasons] = await Promise.all([
      this.client.query<{ code: string; name_es: string; answered_by: 'AT' | 'CAREGIVER'; answer_kind: Scale['answerKind'] }>(
        'SELECT code, name_es, answered_by, answer_kind FROM daily_report_scales ORDER BY code'),
      this.client.query<{ scale_code: string; option_code: string; position: number; label_es: string; meaning_es: string; score: number | null; alert_kind: string | null; alert_text_es: string | null; asks_reason: boolean }>(
        'SELECT scale_code, option_code, position, label_es, meaning_es, score, alert_kind, alert_text_es, asks_reason FROM daily_report_scale_options ORDER BY scale_code, position'),
      this.client.query<{ scale_code: string; reason_code: string; position: number; label_es: string }>(
        'SELECT scale_code, reason_code, position, label_es FROM daily_report_scale_reasons ORDER BY scale_code, position'),
    ]);
    const catalog = new Map<string, Scale>();
    for (const s of scales.rows) catalog.set(s.code, { code: s.code, name: s.name_es, answeredBy: s.answered_by, answerKind: s.answer_kind, options: [], reasons: [] });
    for (const o of options.rows) {
      const option: ScaleOption = {
        code: o.option_code, position: o.position, label: o.label_es, meaning: o.meaning_es, score: o.score,
        alert: o.alert_kind && o.alert_text_es ? { kind: o.alert_kind, text: o.alert_text_es } : null, asksReason: o.asks_reason,
      };
      catalog.get(o.scale_code)?.options.push(option);
    }
    for (const r of reasons.rows) {
      const reason: ScaleReason = { code: r.reason_code, position: r.position, label: r.label_es };
      catalog.get(r.scale_code)?.reasons.push(reason);
    }
    return catalog;
  }

  async projectVersionsOfService(serviceId: string): Promise<ProjectVersionRef[]> {
    const res = await this.client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM patient_therapeutic_projects WHERE contracted_service_id = $1`, [serviceId]);
    return res.rows.map(versionRefOf);
  }

  async projectVersionById(id: string): Promise<ProjectVersionRef | null> {
    const res = await this.client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM patient_therapeutic_projects WHERE id = $1`, [id]);
    return res.rows[0] ? versionRefOf(res.rows[0]) : null;
  }

  async catalogItems(objectiveIds: readonly string[], activityIds: readonly string[]): Promise<{ objectives: ObjectiveRow[]; activities: ActivityRow[] }> {
    const [o, a] = await Promise.all([
      this.client.query<{ id: string; label: string; daily_question: string | null; daily_scale_code: string | null }>(
        'SELECT id, label, daily_question, daily_scale_code FROM therapeutic_specific_objectives WHERE id = ANY($1::uuid[])', [[...objectiveIds]]),
      this.client.query<{ id: string; label: string; description: string | null; suggested_frequency: string | null; daily_scale_code: string | null }>(
        'SELECT id, label, description, suggested_frequency, daily_scale_code FROM therapeutic_activities WHERE id = ANY($1::uuid[])', [[...activityIds]]),
    ]);
    const objectives = new Map(o.rows.map((r): [string, ObjectiveRow] => [r.id, { id: r.id, title: r.label, question: r.daily_question, scaleCode: r.daily_scale_code }]));
    const activities = new Map(a.rows.map((r): [string, ActivityRow] => [r.id, { id: r.id, title: r.label, description: r.description, scaleCode: r.daily_scale_code, frequency: r.suggested_frequency }]));
    return {
      objectives: objectiveIds.flatMap((id) => objectives.get(id) ?? []),
      activities: activityIds.flatMap((id) => activities.get(id) ?? []),
    };
  }

  async reportById(id: string): Promise<ReportContent | null> {
    const head = await this.client.query<{
      worker_id: string; slot_id: string; on_date: string; pti_version_id: string | null; narrative: string;
      narrative_source: ReportContent['narrativeSource']; device_submitted_at: Date; app_version: string;
    }>(
      `SELECT worker_id, slot_id, to_char(on_date, 'YYYY-MM-DD') AS on_date, pti_version_id, narrative, narrative_source, device_submitted_at, app_version
         FROM daily_reports WHERE id = $1`,
      [id],
    );
    const r = head.rows[0];
    if (!r) return null;
    const rows = await this.client.query<{ objective_id: string | null; activity_id: string | null; scale_code: string; option_code: string | null; count_value: number | null; reason_code: string | null }>(
      'SELECT objective_id, activity_id, scale_code, option_code, count_value, reason_code FROM daily_report_answers WHERE report_id = $1',
      [id],
    );
    const answers: ReportAnswer[] = rows.rows.map((a) => ({
      itemKind: a.objective_id ? 'objective' : 'activity',
      itemId: (a.objective_id ?? a.activity_id) as string,
      scaleCode: a.scale_code,
      answer: a.option_code !== null
        ? { kind: 'choice', optionCode: a.option_code, reasonCode: a.reason_code }
        : { kind: 'count', value: a.count_value as number },
    }));
    return {
      workerId: r.worker_id, slotId: r.slot_id, onDate: r.on_date, ptiVersionId: r.pti_version_id, narrative: r.narrative,
      narrativeSource: r.narrative_source, deviceSubmittedAt: r.device_submitted_at, appVersion: r.app_version, answers,
    };
  }

  async reportIdOfGuard(workerId: string, slotId: string, onDate: string): Promise<string | null> {
    const res = await this.client.query<{ id: string }>('SELECT id FROM daily_reports WHERE worker_id = $1 AND slot_id = $2 AND on_date = $3::date', [workerId, slotId, onDate]);
    return res.rows[0]?.id ?? null;
  }

  async insertReport(id: string, c: ReportContent): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, pti_version_id, narrative, narrative_source, device_submitted_at, app_version)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)`,
        [id, c.workerId, c.slotId, c.onDate, c.ptiVersionId, c.narrative, c.narrativeSource, c.deviceSubmittedAt, c.appVersion],
      );
      for (const a of c.answers) {
        const choice = a.answer.kind === 'choice' ? a.answer : null;
        await this.client.query(
          `INSERT INTO daily_report_answers (report_id, objective_id, activity_id, scale_code, option_code, count_value, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, a.itemKind === 'objective' ? a.itemId : null, a.itemKind === 'activity' ? a.itemId : null, a.scaleCode,
            choice?.optionCode ?? null, a.answer.kind === 'count' ? a.answer.value : null, choice?.reasonCode ?? null],
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new DuplicateReportError();
      throw err;
    }
  }
}

export class PgDailyReportRepository implements DailyReportPort {
  private poolMemo?: Pool;

  constructor(pool?: Pool) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  run<T>(work: (tx: DailyReportTx) => Promise<T>): Promise<T> {
    return withActorContext(this.pool, (client) => work(new PgDailyReportTx(client)));
  }
}
