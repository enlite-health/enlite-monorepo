import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import { evaluateTemplateEligibility, isDeniedSlug, ALLOWED_TEMPLATE_CATEGORY } from '../../../notification/application/StageTemplateEligibility';
import { TwilioContentBodyProvider } from '../../../notification/infrastructure/TwilioContentBodyProvider';
import { FUNNEL_STAGES, isFunnelStage } from '../../application/FunnelStageEventEmitter';

/**
 * FunnelStageMessagesController — a configuração "mensagem por etapa" (DEC-12).
 *
 *   GET /api/admin/funnel-stage-messages         (staff)  — as 9 etapas (AR) + templates e a elegibilidade de cada um
 *   PUT /api/admin/funnel-stage-messages/:stage  (ADMIN)  — { template_slug | null, enabled }
 *
 * Só templates ATIVOS, UTILITY, fora da deny-list e ELEGÍVEIS podem ser
 * escolhidos (lex C4-C6); QUALIFIED é built-in e não aceita PUT; toda
 * alteração vira linha em funnel_stage_messages_audit (lex C7). Tudo nasce
 * desligado. País fixo em AR enquanto L3 (BR) estiver aberto (lex C10).
 */

export const STAGE_MESSAGES_COUNTRY = 'AR';

const PutBodySchema = z.object({
  template_slug: z.string().min(1).max(120).nullable(),
  enabled: z.boolean(),
}).strict().refine((b) => !b.enabled || b.template_slug !== null, { message: 'enabled requires template_slug' });

interface StageRow { stage: string; template_slug: string | null; enabled: boolean; channel: string; builtin: string | null; updated_by: string | null; updated_at: string | null; updated_by_name: string | null }
interface TemplateRow { slug: string; name: string; body: string | null; body_twilio: string | null; category: string | null; is_active: boolean; content_sid: string | null }

/**
 * Candidato a aparecer na lista de escolha: passou em categoria e deny-list.
 * Só desses vale buscar o texto na Twilio — os outros nunca são exibidos com
 * prévia, e cada busca é uma chamada de rede.
 */
function isPreviewCandidate(t: TemplateRow): boolean {
  return (t.category ?? '').toUpperCase() === ALLOWED_TEMPLATE_CATEGORY && !isDeniedSlug(t.slug);
}

export class FunnelStageMessagesController {
  private db: Pool;
  private bodyProvider: TwilioContentBodyProvider;
  constructor(bodyProvider?: TwilioContentBodyProvider) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.bodyProvider = bodyProvider ?? new TwilioContentBodyProvider(this.db);
  }

  async list(_req: Request, res: Response): Promise<void> {
    try {
      const [stages, templates] = await Promise.all([
        this.db.query<StageRow>(
          `SELECT m.stage, m.template_slug, m.enabled, m.channel, m.builtin, m.updated_by, m.updated_at, u.display_name AS updated_by_name
           FROM funnel_stage_messages m
           LEFT JOIN users u ON u.firebase_uid = m.updated_by
           WHERE m.country = $1`,
          [STAGE_MESSAGES_COUNTRY],
        ),
        this.db.query<TemplateRow>(`SELECT slug, name, body, body_twilio, category, is_active, content_sid FROM message_templates WHERE is_active = true ORDER BY slug`),
      ]);
      // Todo template vive na Twilio: quem ainda não tem o texto aqui, busca lá e
      // grava. Roda ANTES de avaliar elegibilidade — é o corpo aprovado que diz
      // quantos slots a Meta vai exigir.
      const missing = templates.rows.filter((t) => isPreviewCandidate(t) && !t.body_twilio && t.content_sid);
      if (missing.length > 0) {
        const fetched = await this.bodyProvider.fillMissing(missing.map((t) => ({ slug: t.slug, content_sid: t.content_sid })));
        for (const t of templates.rows) {
          const body = fetched.get(t.slug);
          if (body) t.body_twilio = body;
        }
      }

      const bySt = new Map(stages.rows.map((r) => [r.stage, r]));
      res.status(200).json({
        success: true,
        data: {
          country: STAGE_MESSAGES_COUNTRY,
          stages: FUNNEL_STAGES.map((stage) => {
            const r = bySt.get(stage);
            return {
              stage,
              templateSlug: r?.template_slug ?? null,
              enabled: r?.enabled ?? false,
              channel: r?.channel ?? 'whatsapp',
              builtin: r?.builtin ?? null,
              updatedBy: r?.updated_by_name ?? null,
              updatedAt: r?.updated_at ?? null,
            };
          }),
          templates: templates.rows.map((t) => {
            const e = evaluateTemplateEligibility(t);
            // `body` é o contrato de envio (nomeado); `bodyTwilio` é o texto aprovado na
            // Meta, só para a tela mostrar o que a cuidadora recebe. Nunca trocar um pelo
            // outro: o envio lê `body` para montar as contentVariables posicionais.
            return { slug: t.slug, name: t.name, body: t.body, bodyTwilio: t.body_twilio, category: t.category, eligible: e.eligible, reason: e.reason, placeholders: e.placeholders, unsupported: e.unsupported };
          }),
        },
      });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'FunnelStageMessagesController:list' });
      res.status(500).json({ success: false, error: 'Failed to list funnel stage messages' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    const stage = String(req.params.stage).toUpperCase();
    if (!isFunnelStage(stage)) {
      res.status(400).json({ success: false, error: 'Unknown stage' });
      return;
    }
    if (stage === 'QUALIFIED') {
      res.status(409).json({ success: false, error: 'QUALIFIED is built-in (interview invite) and cannot be configured' });
      return;
    }
    const parsed = PutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }
    try {
      const { template_slug: slug, enabled } = parsed.data;
      if (slug) {
        const t = await this.db.query<TemplateRow>(`SELECT slug, name, body, body_twilio, category, is_active, content_sid FROM message_templates WHERE slug = $1`, [slug]);
        const row = t.rows[0];
        if (!row || !row.is_active) {
          res.status(400).json({ success: false, error: 'Template not found or inactive' });
          return;
        }
        const e = evaluateTemplateEligibility(row);
        if (!e.eligible) {
          res.status(400).json({ success: false, error: 'Template not eligible for stage messages', details: { reason: e.reason, unsupported: e.unsupported } });
          return;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actorUid = ((req as any).user as { uid?: string } | undefined)?.uid ?? null;
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE funnel_stage_messages
           SET template_slug = $3, enabled = $4, updated_by = $5, updated_at = NOW()
           WHERE country = $1 AND stage = $2`,
          [STAGE_MESSAGES_COUNTRY, stage, slug, enabled, actorUid],
        );
        await client.query(
          `INSERT INTO funnel_stage_messages_audit (country, stage, template_slug, enabled, actor_uid) VALUES ($1, $2, $3, $4, $5)`,
          [STAGE_MESSAGES_COUNTRY, stage, slug, enabled, actorUid],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      res.status(200).json({ success: true, data: { country: STAGE_MESSAGES_COUNTRY, stage, templateSlug: slug, enabled } });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'FunnelStageMessagesController:update' });
      res.status(500).json({ success: false, error: 'Failed to update funnel stage message' });
    }
  }
}
