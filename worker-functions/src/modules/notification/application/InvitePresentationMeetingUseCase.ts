/**
 * InvitePresentationMeetingUseCase — REQ-09: "invitar a la reunión de presentación, y cuando
 * vos invitás, la Luz habla" (Marcel, 26/08).
 *
 * Um clique humano (tarjeta do Kanban ou lista de prestadores) → convite por WhatsApp
 * (template UTILITY escolhido pelo admin) com o link da reunião recorrente → messaging_outbox.
 * A resposta cai na Luz pelo espelho Chatwoot já existente — este use case só garante que o
 * convite passe pelo MESMO cano da mensageria (outbox → Twilio → espelho).
 *
 * Cada clique vira uma linha em presentation_invite_log: enfileirado OU pulado com motivo.
 * Guards, na ordem: config desligada · template · link · worker · país · DISABLED · opt-out ·
 * idempotência 7 d (sob advisory lock — dois cliques simultâneos não geram dois convites).
 */
import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import { optedOutExistsSql } from '@shared/database/messagingOptOutFilter';

export const PRESENTATION_INVITE_COUNTRY = 'AR';
export const PRESENTATION_INVITE_COOLDOWN = '7 days';
export const PRESENTATION_INVITE_ALLOWED_CATEGORY = 'UTILITY';
/** Variáveis que o sistema completa — nada além disto entra no template. */
export const PRESENTATION_INVITE_PLACEHOLDERS = new Set(['worker_name', 'name', 'meet_link', 'schedule_label']);

export type PresentationInviteSource = 'kanban' | 'workers_list';
export type PresentationInviteSkip =
  | 'DISABLED_CONFIG' | 'NO_TEMPLATE' | 'TEMPLATE_INACTIVE' | 'TEMPLATE_NOT_ALLOWED' | 'NO_MEET_LINK'
  | 'WORKER_NOT_FOUND' | 'COUNTRY_BLOCKED' | 'COUNTRY_MISMATCH' | 'SIN_VINCULO' | 'WORKER_DISABLED' | 'OPT_OUT' | 'ALREADY_INVITED';

export interface InvitePresentationInput {
  workerId: string;
  jobPostingId?: string | null;
  actorUid: string;
  source: PresentationInviteSource;
}
export type InvitePresentationResult =
  | { status: 'queued'; outboxId: string }
  | { status: 'skipped'; skipReason: PresentationInviteSkip };

interface TokenGenerator { generate(workerId: string, fieldName: string): Promise<string> }
interface Publisher { publish(topic: string, payload: unknown): Promise<unknown> }

interface SettingsRow {
  enabled: boolean; meet_link: string | null; schedule_label: string | null; template_slug: string | null;
  body: string | null; category: string | null; is_active: boolean | null;
}
interface WorkerRow { id: string; status: string; country: string | null; opted_out: boolean; phone_ar: boolean; has_link: boolean }

export function templatePlaceholders(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (m) => m[1])));
}

export class InvitePresentationMeetingUseCase {
  constructor(
    private readonly db: Pool,
    private readonly tokens: TokenGenerator,
    private readonly pubsub: Publisher,
  ) {}

  async execute(input: InvitePresentationInput): Promise<InvitePresentationResult> {
    const log = logger.child({ workerId: input.workerId, jobPostingId: input.jobPostingId ?? undefined });

    const { rows: [worker] } = await this.db.query<WorkerRow>(
      `SELECT w.id, w.status, w.country, ${optedOutExistsSql('w.id')} AS opted_out,
              (regexp_replace(COALESCE(w.phone, ''), '[^0-9+]', '', 'g') ~ '^\\+?54') AS phone_ar,
              ((w.lgpd_consent_at IS NOT NULL OR w.terms_accepted_at IS NOT NULL OR w.privacy_accepted_at IS NOT NULL)
                AND COALESCE(w.email, '') NOT ILIKE '%@enlite.import' AND COALESCE(w.auth_uid, '') NOT LIKE 'base1import%') AS has_link
       FROM workers w WHERE w.id = $1 LIMIT 1`,
      [input.workerId],
    );
    const country = worker?.country ?? PRESENTATION_INVITE_COUNTRY;

    const skip = async (reason: PresentationInviteSkip, templateSlug: string | null = null): Promise<InvitePresentationResult> => {
      await this.db.query(
        `INSERT INTO presentation_invite_log (worker_id, job_posting_id, actor_uid, source, template_slug, status, skip_reason, country)
         VALUES ($1, $2, $3, $4, $5, 'skipped', $6, $7)`,
        [worker?.id ?? null, input.jobPostingId ?? null, input.actorUid, input.source, templateSlug, reason, country],
      );
      log.info({ msg: 'presentation_invite.skipped', reason, source: input.source });
      return { status: 'skipped', skipReason: reason };
    };

    if (!worker) return skip('WORKER_NOT_FOUND');
    // lex C2: 'AR' no banco é DEFAULT, não medição — o país vale por DOIS sinais (coluna + telefone +54).
    if (worker.country !== PRESENTATION_INVITE_COUNTRY) return skip('COUNTRY_BLOCKED');
    if (!worker.phone_ar) return skip('COUNTRY_MISMATCH');
    // lex C1: só quem ELA MESMA entregou o dado e aceitou o aviso (self-cadastro). Ficha importada de
    // planilha/ClickUp nunca teve relação com a Enlite — convite ativo sem base legal (Ley 25.326 art. 5/27).
    if (!worker.has_link) return skip('SIN_VINCULO');

    const { rows: [cfg] } = await this.db.query<SettingsRow>(
      `SELECT s.enabled, s.meet_link, s.schedule_label, s.template_slug, t.body, t.category, t.is_active
       FROM presentation_invite_settings s
       LEFT JOIN message_templates t ON t.slug = s.template_slug
       WHERE s.country = $1`,
      [PRESENTATION_INVITE_COUNTRY],
    );
    if (!cfg || !cfg.enabled) return skip('DISABLED_CONFIG', cfg?.template_slug ?? null);
    if (!cfg.template_slug || cfg.body === null) return skip('NO_TEMPLATE');
    if (!cfg.is_active) return skip('TEMPLATE_INACTIVE', cfg.template_slug);
    const placeholders = templatePlaceholders(cfg.body);
    if (cfg.category !== PRESENTATION_INVITE_ALLOWED_CATEGORY || placeholders.some((p) => !PRESENTATION_INVITE_PLACEHOLDERS.has(p))) {
      return skip('TEMPLATE_NOT_ALLOWED', cfg.template_slug);
    }
    if (!cfg.meet_link) return skip('NO_MEET_LINK', cfg.template_slug);
    if (worker.status === 'DISABLED') return skip('WORKER_DISABLED', cfg.template_slug);
    if (worker.opted_out) return skip('OPT_OUT', cfg.template_slug);

    const variables: Record<string, string> = {};
    for (const p of placeholders) {
      if (p === 'meet_link') variables[p] = cfg.meet_link;
      else if (p === 'schedule_label') variables[p] = cfg.schedule_label ?? '';
      else variables[p] = await this.tokens.generate(worker.id, p); // nome NUNCA em texto: token
    }

    const client: PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`presentation_invite:${worker.id}`]);
      const { rows: dup } = await client.query(
        `SELECT id FROM presentation_invite_log
         WHERE worker_id = $1 AND status = 'queued' AND created_at > NOW() - INTERVAL '${PRESENTATION_INVITE_COOLDOWN}'
         LIMIT 1`,
        [worker.id],
      );
      if (dup.length > 0) {
        await client.query(
          `INSERT INTO presentation_invite_log (worker_id, job_posting_id, actor_uid, source, template_slug, status, skip_reason, country)
           VALUES ($1, $2, $3, $4, $5, 'skipped', 'ALREADY_INVITED', $6)`,
          [worker.id, input.jobPostingId ?? null, input.actorUid, input.source, cfg.template_slug, country],
        );
        await client.query('COMMIT');
        log.info({ msg: 'presentation_invite.skipped', reason: 'ALREADY_INVITED', source: input.source });
        return { status: 'skipped', skipReason: 'ALREADY_INVITED' };
      }
      const { rows: [outbox] } = await client.query<{ id: string }>(
        `INSERT INTO messaging_outbox (worker_id, job_posting_id, template_slug, variables, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending') RETURNING id`,
        [worker.id, input.jobPostingId ?? null, cfg.template_slug, JSON.stringify(variables)],
      );
      await client.query(
        `INSERT INTO presentation_invite_log (worker_id, job_posting_id, actor_uid, source, template_slug, outbox_id, status, country)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)`,
        [worker.id, input.jobPostingId ?? null, input.actorUid, input.source, cfg.template_slug, outbox.id, country],
      );
      await client.query('COMMIT');
      await this.pubsub.publish('outbox-enqueued', { outboxId: outbox.id });
      log.info({ msg: 'presentation_invite.queued', outboxId: outbox.id, source: input.source });
      return { status: 'queued', outboxId: outbox.id };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
