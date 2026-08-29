/**
 * PresentationInviteController — REQ-09 (planning 26/08).
 *
 * GET  /api/admin/presentation-invite/settings     staff lê a config (+ templates elegíveis)
 * PUT  /api/admin/presentation-invite/settings     admin grava (auditado)
 * POST /api/admin/workers/:workerId/presentation-invite  staff clica → enfileira ou pula (motivo)
 * GET  /api/admin/presentation-invite/last?workerIds=a,b  último convite por pessoa (tarjeta/lista)
 * GET  /api/admin/presentation-invite/stats        contagens 30 d por status/motivo/origem
 *
 * Controller sem regra de negócio: validação (zod strict) e delegação ao use case.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import {
  InvitePresentationMeetingUseCase, PRESENTATION_INVITE_COUNTRY, PRESENTATION_INVITE_ALLOWED_CATEGORY,
  PRESENTATION_INVITE_PLACEHOLDERS, templatePlaceholders,
} from '../../application/InvitePresentationMeetingUseCase';

/** lex C4: o link é credencial de acesso — só sala do Google Meet, nunca URL livre. */
export const MEET_LINK_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** lex C4: o rótulo do horário é texto livre que vai ao WhatsApp — nada clínico nem identificador. */
export const SCHEDULE_LABEL_DENY = /paciente|diagn|cid|patolog|medicaci|enfermedad|doença|tratamiento|dni|cuil|\d{6,}/i;
/** lex C3 (Decreto 1558/2001, art. 27): o template tem de dizer, de forma expressa, como sair. */
export const OPT_OUT_CLAUSE_RE = /baja|no recibir|dejar de recibir|no querés recibir|stop|salir/i;

const settingsSchema = z.object({
  template_slug: z.string().min(1).max(100).nullable(),
  meet_link: z.string().max(200).regex(MEET_LINK_RE, 'meet_link must be a Google Meet room').nullable(),
  schedule_label: z.string().max(200).refine((v) => !SCHEDULE_LABEL_DENY.test(v), 'schedule_label contains a denied term').nullable(),
  enabled: z.boolean(),
}).strict().refine((b) => !b.enabled || (b.template_slug && b.meet_link), { message: 'enabled requires template_slug and meet_link' });

const inviteSchema = z.object({
  job_posting_id: z.string().uuid().nullable().optional(),
  source: z.enum(['kanban', 'workers_list']),
}).strict();

const actorOf = (req: Request): string | null => (req as Request & { user?: { uid?: string } }).user?.uid ?? null;

export class PresentationInviteController {
  private get pool() { return DatabaseConnection.getInstance().getPool(); }

  constructor(private readonly useCase: InvitePresentationMeetingUseCase) {}

  getSettings = async (_req: Request, res: Response): Promise<void> => {
    try {
      const { rows: [s] } = await this.pool.query(
        `SELECT s.template_slug, s.meet_link, s.schedule_label, s.enabled, s.updated_at, COALESCE(u.display_name, s.updated_by) AS updated_by
         FROM presentation_invite_settings s LEFT JOIN users u ON u.firebase_uid = s.updated_by WHERE s.country = $1`,
        [PRESENTATION_INVITE_COUNTRY],
      );
      const { rows: templates } = await this.pool.query<{ slug: string; name: string; body: string; category: string | null; is_active: boolean }>(
        `SELECT slug, name, body, category, is_active FROM message_templates ORDER BY slug`,
      );
      res.json({
        success: true,
        data: {
          country: PRESENTATION_INVITE_COUNTRY,
          templateSlug: s?.template_slug ?? null, meetLink: s?.meet_link ?? null, scheduleLabel: s?.schedule_label ?? null,
          enabled: s?.enabled ?? false, updatedBy: s?.updated_by ?? null, updatedAt: s?.updated_at ?? null,
          templates: templates.map((t) => {
            const ph = templatePlaceholders(t.body ?? '');
            const unsupported = ph.filter((p) => !PRESENTATION_INVITE_PLACEHOLDERS.has(p));
            const reason = t.category !== PRESENTATION_INVITE_ALLOWED_CATEGORY ? 'CATEGORY' : unsupported.length ? 'PLACEHOLDERS'
              : !OPT_OUT_CLAUSE_RE.test(t.body ?? '') ? 'OPT_OUT_CLAUSE' : !t.is_active ? 'INACTIVE' : null;
            return { slug: t.slug, name: t.name, category: t.category, eligible: reason === null, reason, placeholders: ph, unsupported };
          }),
        },
      });
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PresentationInviteController:getSettings' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  };

  updateSettings = async (req: Request, res: Response): Promise<void> => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() }); return; }
    const b = parsed.data;
    const client = await this.pool.connect();
    try {
      if (b.template_slug) {
        const { rows: [t] } = await this.pool.query<{ body: string; category: string | null; is_active: boolean }>(
          `SELECT body, category, is_active FROM message_templates WHERE slug = $1`, [b.template_slug],
        );
        const bad = !t ? 'NOT_FOUND' : t.category !== PRESENTATION_INVITE_ALLOWED_CATEGORY ? 'CATEGORY'
          : templatePlaceholders(t.body ?? '').some((p) => !PRESENTATION_INVITE_PLACEHOLDERS.has(p)) ? 'PLACEHOLDERS'
          : !OPT_OUT_CLAUSE_RE.test(t.body ?? '') ? 'OPT_OUT_CLAUSE' : null;
        // Template INATIVO pode ser escolhido (placeholder até a Meta aprovar) — o envio é que espera.
        if (bad) { res.status(400).json({ success: false, error: 'Template not eligible', details: { reason: bad } }); return; } // release no finally
      }
      const actor = actorOf(req);
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO presentation_invite_settings (country, template_slug, meet_link, schedule_label, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (country) DO UPDATE SET template_slug = EXCLUDED.template_slug, meet_link = EXCLUDED.meet_link,
           schedule_label = EXCLUDED.schedule_label, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [PRESENTATION_INVITE_COUNTRY, b.template_slug, b.meet_link, b.schedule_label, b.enabled, actor],
      );
      await client.query(
        `INSERT INTO presentation_invite_settings_audit (country, template_slug, meet_link, schedule_label, enabled, actor_uid) VALUES ($1, $2, $3, $4, $5, $6)`,
        [PRESENTATION_INVITE_COUNTRY, b.template_slug, b.meet_link, b.schedule_label, b.enabled, actor],
      );
      await client.query('COMMIT');
      res.json({ success: true, data: { country: PRESENTATION_INVITE_COUNTRY, templateSlug: b.template_slug, meetLink: b.meet_link, scheduleLabel: b.schedule_label, enabled: b.enabled } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PresentationInviteController:updateSettings' });
      res.status(500).json({ success: false, error: 'Internal error' });
    } finally {
      client.release();
    }
  };

  invite = async (req: Request, res: Response): Promise<void> => {
    const parsed = inviteSchema.safeParse(req.body ?? {});
    const workerId = String(req.params.workerId ?? '');
    const actor = actorOf(req);
    if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(workerId)) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }
    if (!actor) { res.status(401).json({ success: false, error: 'Unauthenticated' }); return; }
    try {
      const result = await this.useCase.execute({ workerId, jobPostingId: parsed.data.job_posting_id ?? null, actorUid: actor, source: parsed.data.source });
      res.status(result.status === 'queued' ? 202 : 200).json({ success: true, data: result });
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PresentationInviteController:invite', workerId });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  };

  last = async (req: Request, res: Response): Promise<void> => {
    const ids = String(req.query.workerIds ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 200);
    if (ids.length === 0) { res.json({ success: true, data: {} }); return; }
    try {
      const { rows } = await this.pool.query<{ worker_id: string; status: string; skip_reason: string | null; created_at: string; actor: string | null }>(
        `SELECT DISTINCT ON (l.worker_id) l.worker_id, l.status, l.skip_reason, l.created_at, COALESCE(u.display_name, l.actor_uid) AS actor
         FROM presentation_invite_log l LEFT JOIN users u ON u.firebase_uid = l.actor_uid
         WHERE l.worker_id = ANY($1::uuid[]) AND l.status = 'queued'
         ORDER BY l.worker_id, l.created_at DESC`,
        [ids],
      );
      const data: Record<string, { at: string; by: string | null }> = {};
      for (const r of rows) data[r.worker_id] = { at: r.created_at, by: r.actor };
      res.json({ success: true, data });
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PresentationInviteController:last' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  };

  stats = async (_req: Request, res: Response): Promise<void> => {
    try {
      const { rows } = await this.pool.query<{ status: string; skip_reason: string | null; source: string; n: string }>(
        `SELECT status, skip_reason, source, COUNT(*)::text AS n FROM presentation_invite_log
         WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY status, skip_reason, source ORDER BY status, skip_reason, source`,
      );
      const { rows: [att] } = await this.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM presentation_invite_log WHERE attended_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`,
      );
      res.json({ success: true, data: { windowDays: 30, rows: rows.map((r) => ({ status: r.status, skipReason: r.skip_reason, source: r.source, count: Number(r.n) })), attended: Number(att?.n ?? 0) } });
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PresentationInviteController:stats' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  };
}
