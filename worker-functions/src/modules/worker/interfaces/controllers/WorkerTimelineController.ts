import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type TimelineEvent = {
  kind: 'status_change' | 'funnel_stage' | 'whatsapp';
  id: string;
  label: string;
  old_value: string | null;
  new_value: string;
  changed_by: string | null;
  application_id: string | null;
  template_slug: string | null;
  occurred_at: string;
};

const TIMELINE_QUERY = `
  SELECT
    'status_change'           AS kind,
    h.id                      AS id,
    h.field_name              AS label,
    h.old_value               AS old_value,
    h.new_value               AS new_value,
    h.changed_by              AS changed_by,
    NULL::uuid                AS application_id,
    NULL::text                AS template_slug,
    h.created_at              AS occurred_at
  FROM worker_status_history h
  WHERE h.worker_id = $1

  UNION ALL

  SELECT
    'funnel_stage'            AS kind,
    sh.id                     AS id,
    sh.field_name             AS label,
    sh.old_value              AS old_value,
    sh.new_value              AS new_value,
    sh.changed_by             AS changed_by,
    sh.application_id         AS application_id,
    NULL::text                AS template_slug,
    sh.created_at             AS occurred_at
  FROM worker_job_application_stage_history sh
  INNER JOIN worker_job_applications wja ON wja.id = sh.application_id
  WHERE wja.worker_id = $1

  UNION ALL

  SELECT
    'whatsapp'                AS kind,
    bdl.id                    AS id,
    bdl.template_slug         AS label,
    NULL::text                AS old_value,
    bdl.status                AS new_value,
    bdl.triggered_by          AS changed_by,
    NULL::uuid                AS application_id,
    bdl.template_slug         AS template_slug,
    bdl.dispatched_at         AS occurred_at
  FROM whatsapp_bulk_dispatch_logs bdl
  WHERE bdl.worker_id = $1

  ORDER BY occurred_at DESC
  LIMIT $2 OFFSET $3
`;

const TIMELINE_COUNT_QUERY = `
  SELECT COUNT(*) AS total FROM (
    SELECT h.id FROM worker_status_history h WHERE h.worker_id = $1
    UNION ALL
    SELECT sh.id FROM worker_job_application_stage_history sh
    INNER JOIN worker_job_applications wja ON wja.id = sh.application_id
    WHERE wja.worker_id = $1
    UNION ALL
    SELECT bdl.id FROM whatsapp_bulk_dispatch_logs bdl WHERE bdl.worker_id = $1
  ) combined
`;

export class WorkerTimelineController {
  constructor(private readonly db: Pool) {}

  async getTimeline(req: Request, res: Response): Promise<void> {
    const paramsResult = ParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({ success: false, error: 'Invalid worker id', details: paramsResult.error.flatten() });
      return;
    }

    const queryResult = QuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({ success: false, error: 'Invalid query params', details: queryResult.error.flatten() });
      return;
    }

    const { id } = paramsResult.data;
    const { limit, offset } = queryResult.data;

    try {
      const [eventsRes, countRes] = await Promise.all([
        this.db.query<TimelineEvent>(TIMELINE_QUERY, [id, limit, offset]),
        this.db.query<{ total: string }>(TIMELINE_COUNT_QUERY, [id]),
      ]);

      const data: TimelineEvent[] = eventsRes.rows.map(row => ({
        kind: row.kind,
        id: row.id,
        label: row.label,
        old_value: row.old_value,
        new_value: row.new_value,
        changed_by: row.changed_by,
        application_id: row.application_id,
        template_slug: row.template_slug,
        occurred_at: row.occurred_at,
      }));

      const total = parseInt(countRes.rows[0]?.total ?? '0', 10);

      res.status(200).json({ success: true, data, total, limit, offset });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  }
}
