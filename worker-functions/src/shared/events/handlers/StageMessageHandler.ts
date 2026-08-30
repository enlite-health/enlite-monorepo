import { Pool } from 'pg';
import { PubSubClient } from '../PubSubClient';
import { TokenService } from '../../../modules/notification/infrastructure/TokenService';
import { logger } from '../../logging';
import { optedOutExistsSql } from '../../database/messagingOptOutFilter';
import {
  buildStageVariables,
  evaluateTemplateEligibility,
} from '../../../modules/notification/application/StageTemplateEligibility';

/**
 * StageMessageHandler — a "mensagem por etapa" (DEC-12 / PEND-14).
 *
 * Recebe `funnel_stage.<etapa>` EMITIDO PELO MOVIMENTO DA TARJETA (source
 * 'kanban') e, se a etapa tem template LIGADO em `funnel_stage_messages`,
 * enfileira o template na `messaging_outbox`. Cada decisão vira UMA linha em
 * `funnel_stage_message_log` com a autoria (quem moveu) — enviada OU pulada.
 *
 * Guards (lex 29/08), na ordem:
 *   C9  gatilho SÓ humano: evento sem source 'kanban' (Talentum audit-only) → pulo;
 *   C10 país: só worker AR enquanto L3 (consentimento BR) estiver aberto;
 *   etapa desligada / sem template / template inativo, MARKETING, deny-list
 *   de lembrete, placeholder fora da allowlist (C4-C6) → pulo;
 *   vaga/worker inexistentes → worker DISABLED → opt-out (MESMO predicado do
 *   OutboxProcessor, que continua o ponto único de defesa — C2) → pulo;
 *   C3  idempotência por (worker, vaga, ETAPA) em 7 dias, serializada por
 *       advisory lock do par (dois arrastos em segundos não passam os dois).
 *
 * QUALIFIED NÃO passa por aqui: é o QualifiedInterviewHandler (built-in).
 * Nada de disparo em massa: 1 evento = 1 tarjeta = no máximo 1 mensagem.
 */

export const STAGE_MESSAGE_COOLDOWN = '7 days';

export type StageSkipReason =
  | 'DISABLED' | 'NO_TEMPLATE' | 'TEMPLATE_INACTIVE' | 'TEMPLATE_NOT_ALLOWED' | 'WORKER_NOT_FOUND'
  | 'WORKER_DISABLED' | 'OPT_OUT' | 'ALREADY_SENT' | 'VACANCY_NOT_FOUND' | 'SOURCE_NOT_HUMAN' | 'COUNTRY_BLOCKED';

interface ConfigRow { template_slug: string | null; enabled: boolean; builtin: string | null; body: string | null; category: string | null; is_active: boolean | null }
interface VacancyRow { case_number: number | null; country: string | null }
interface WorkerRow { id: string; status: string | null; country: string | null; opted_out: boolean }

export function createStageMessageHandler(
  db: Pool,
  pubsub: PubSubClient,
  tokenService: TokenService,
  stage: string,
): (payload: Record<string, unknown>) => Promise<void> {
  return async (payload) => {
    const workerId = payload.workerId as string;
    const jobPostingId = payload.jobPostingId as string;
    const actorUid = typeof payload.actorUid === 'string' ? payload.actorUid : null;
    const source: 'kanban' | 'talentum' | 'system' = payload.source === 'kanban' ? 'kanban' : payload.source === 'talentum' ? 'talentum' : 'system';

    const [vacancyResult, workerResult] = await Promise.all([
      db.query<VacancyRow>(`SELECT case_number, country FROM job_postings WHERE id = $1 AND deleted_at IS NULL`, [jobPostingId]),
      db.query<WorkerRow>(
        `SELECT w.id, w.status, w.country, ${optedOutExistsSql('w.id')} AS opted_out FROM workers w WHERE w.id = $1`,
        [workerId],
      ),
    ]);
    const vacancy = vacancyResult.rows[0];
    const worker = workerResult.rows[0];
    const country = vacancy?.country ?? worker?.country ?? null;

    const configResult = country
      ? await db.query<ConfigRow>(
          `SELECT m.template_slug, m.enabled, m.builtin, t.body, t.category, t.is_active
           FROM funnel_stage_messages m
           LEFT JOIN message_templates t ON t.slug = m.template_slug
           WHERE m.country = $1 AND m.stage = $2`,
          [country, stage],
        )
      : { rows: [] as ConfigRow[] };
    const config = configResult.rows[0];
    const templateSlug = config?.template_slug ?? null;

    const log = async (status: 'queued' | 'skipped', extra: { skipReason?: StageSkipReason; outboxId?: string }): Promise<void> => {
      logger.info({ msg: 'funnel_stage_message', stage, status, reason: extra.skipReason ?? null, workerId, jobPostingId, source });
      if (!country) return; // vaga E worker desconhecidos: sem país não há linha (NOT NULL sem default)
      await db.query(
        `INSERT INTO funnel_stage_message_log
           (worker_id, job_posting_id, stage, template_slug, actor_uid, source, outbox_id, status, skip_reason, country)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [worker?.id ?? null, vacancy ? jobPostingId : null, stage, templateSlug, actorUid, source, extra.outboxId ?? null, status, extra.skipReason ?? null, country],
      );
    };

    if (source !== 'kanban') { await log('skipped', { skipReason: 'SOURCE_NOT_HUMAN' }); return; }
    if (!vacancy) { await log('skipped', { skipReason: 'VACANCY_NOT_FOUND' }); return; }
    if (!worker) { await log('skipped', { skipReason: 'WORKER_NOT_FOUND' }); return; }
    if ((worker.country ?? country) !== 'AR') { await log('skipped', { skipReason: 'COUNTRY_BLOCKED' }); return; }
    // Etapa desligada ou sem template: é o estado padrão — não é erro, é "não configurado".
    if (!config || config.builtin || !config.enabled) { await log('skipped', { skipReason: 'DISABLED' }); return; }
    if (!templateSlug) { await log('skipped', { skipReason: 'NO_TEMPLATE' }); return; }
    const eligibility = evaluateTemplateEligibility({ slug: templateSlug, body: config.body, category: config.category, is_active: config.is_active });
    if (eligibility.reason === 'INACTIVE') { await log('skipped', { skipReason: 'TEMPLATE_INACTIVE' }); return; }
    if (!eligibility.eligible) { await log('skipped', { skipReason: 'TEMPLATE_NOT_ALLOWED' }); return; }
    if (worker.status === 'DISABLED') { await log('skipped', { skipReason: 'WORKER_DISABLED' }); return; }
    if (worker.opted_out) { await log('skipped', { skipReason: 'OPT_OUT' }); return; }

    // Variáveis: nome vai como TOKEN (nunca o valor); nº do caso vai cru.
    const needsName = eligibility.placeholders.some((p) => p === 'worker_name' || p === 'name');
    const workerNameToken = needsName ? await tokenService.generate(workerId, 'worker_name') : null;
    const variables = buildStageVariables(eligibility.placeholders, { workerNameToken, caseNumber: vacancy.case_number });

    // C3: check + insert numa transação serializada por par (worker, vaga).
    const client = await db.connect();
    let outboxId: string | null = null;
    let alreadySent = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, [workerId, jobPostingId]);
      const dup = await client.query<{ id: string }>(
        `SELECT id FROM funnel_stage_message_log
         WHERE worker_id = $1 AND job_posting_id = $2 AND stage = $3 AND status = 'queued'
           AND created_at > NOW() - INTERVAL '${STAGE_MESSAGE_COOLDOWN}'
         LIMIT 1`,
        [workerId, jobPostingId, stage],
      );
      if (dup.rows.length > 0) {
        alreadySent = true;
      } else {
        const outbox = await client.query<{ id: string }>(
          `INSERT INTO messaging_outbox (worker_id, job_posting_id, template_slug, variables, status, attempts)
           VALUES ($1, $2, $3, $4::jsonb, 'pending', 0)
           RETURNING id`,
          [workerId, jobPostingId, templateSlug, JSON.stringify(variables)],
        );
        outboxId = outbox.rows[0].id;
        await client.query(
          `INSERT INTO funnel_stage_message_log
             (worker_id, job_posting_id, stage, template_slug, actor_uid, source, outbox_id, status, country)
           VALUES ($1, $2, $3, $4, $5, 'kanban', $6, 'queued', $7)`,
          [workerId, jobPostingId, stage, templateSlug, actorUid, outboxId, country],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (alreadySent) { await log('skipped', { skipReason: 'ALREADY_SENT' }); return; }
    await pubsub.publish('outbox-enqueued', { outboxId });
    logger.info({ msg: 'funnel_stage_message', stage, status: 'queued', workerId, jobPostingId, source, outboxId });
  };
}
