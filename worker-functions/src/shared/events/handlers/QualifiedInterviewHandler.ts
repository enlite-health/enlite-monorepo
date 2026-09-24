import { Pool } from 'pg';
import type { DomainEventHandler } from '../DomainEventProcessor';
import { PubSubClient } from '../PubSubClient';
import { TokenService } from '../../../modules/notification/infrastructure/TokenService';
import { logger } from '../../logging';
import { optedOutExistsSql } from '../../database/messagingOptOutFilter';
import { resolveOfferedSlots, type VacancySlotSource } from '../../../modules/matching/domain/interviewSlotResolver';
import { formatCaseNumber } from '../../utils/caseNumberFormat';

export type InviteSkipReason =
  | 'VACANCY_NOT_FOUND'
  | 'NO_FUTURE_SLOT'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_DISABLED'
  | 'OPT_OUT'
  | 'ALREADY_INVITED';

/**
 * Quem disparou o `funnel_stage.qualified` — só para MEDIR (log), nunca para
 * decidir: desde o PEND-14 o arrasto humano da tarjeta (`kanban`) também
 * dispara o convite, além do webhook da Talentum. A decisão de manter ou não
 * o convite no arrasto é do Gabriel, com este dado na mão.
 */
export type QualifiedSource = 'human_drag' | 'talentum' | 'unknown';

export function qualifiedSourceOf(payload: Record<string, unknown>): QualifiedSource {
  if (payload.source === 'kanban') return 'human_drag';
  if (payload.source === 'talentum') return 'talentum';
  return 'unknown';
}

/** Janela de idempotência: mesmo (worker, vaga, template) não repete em 7 dias (índice da mig 173). */
export const INVITE_IDEMPOTENCY_WINDOW = '7 days';

interface VacancyRow extends VacancySlotSource {
  case_number: number | null;
  country: string | null;
}

interface WorkerRow {
  id: string;
  status: string | null;
  country: string | null;
  opted_out: boolean;
}

/**
 * Cria o handler para o evento `funnel_stage.qualified`.
 *
 * Quando um worker transita para QUALIFIED no Talentum:
 *   1. Busca a vaga (slots fixos + recorrente + fuso, mig 291) e o worker
 *      (status + opt-out, MESMO predicado do OutboxProcessor).
 *   2. Resolve a oferta (`resolveOfferedSlots`): fixos futuros ∪ próximas
 *      ocorrências do recorrente, no fuso da vaga.
 *   3. Pré-checks — cada um que falha grava UMA linha em
 *      `interview_invite_skips` (contável, D211.4 / lex C1-C3) e sai:
 *      vaga inexistente · sem slot futuro · worker inexistente · DISABLED ·
 *      opt-out · já convidado nos últimos 7 dias (idempotência).
 *   4. Insere na messaging_outbox com template 'qualified_worker_request'
 *      Variáveis Twilio: {{1}}=slot_1 {{2}}=slot_2 {{3}}=slot_3 {{4}}=case_number
 *      Os meet_links não vão no template — BookInterviewSlotUseCase recomputa a
 *      MESMA oferta (asOf = created_at da mensagem) quando o worker escolhe.
 *   5. Publica no Pub/Sub para processamento imediato
 *   6. Marca interview_response = 'pending' em worker_job_applications
 *
 * O opt-out continua sendo barrado no OutboxProcessor (ponto único de
 * defesa, incidente 10/07): o pré-check aqui é ADITIVO, só para contar.
 */
export function createQualifiedInterviewHandler(
  db: Pool,
  pubsub: PubSubClient,
  _tokenService: TokenService,
): DomainEventHandler {
  return async (payload, meta) => {
    const workerId = payload.workerId as string;
    const jobPostingId = payload.jobPostingId as string;
    // O id vem da LINHA processada, entregue pelo DomainEventProcessor — o
    // emissor não o conhece antes do INSERT (D187: fixture não confirma suposição).
    const domainEventId = meta.eventId;
    const source = qualifiedSourceOf(payload);

    const [vacancyResult, workerResult] = await Promise.all([
      db.query<VacancyRow>(
        `SELECT case_number, country, timezone,
                meet_link_1, meet_datetime_1,
                meet_link_2, meet_datetime_2,
                meet_link_3, meet_datetime_3,
                meet_recurring_weekday, meet_recurring_time, meet_recurring_link
         FROM job_postings
         WHERE id = $1 AND deleted_at IS NULL`,
        [jobPostingId],
      ),
      db.query<WorkerRow>(
        `SELECT w.id, w.status, w.country, ${optedOutExistsSql('w.id')} AS opted_out
         FROM workers w
         WHERE w.id = $1`,
        [workerId],
      ),
    ]);

    const vacancy = vacancyResult.rows[0];
    const worker = workerResult.rows[0];
    const country = vacancy?.country ?? worker?.country ?? null;

    const skip = async (reason: InviteSkipReason, detail: Record<string, unknown> = {}): Promise<void> => {
      logger.warn({ msg: 'interview_invite.skipped', reason, workerId, jobPostingId, domainEventId, source, ...detail });
      if (!country) {
        // Vaga E worker desconhecidos: sem país não há linha (NOT NULL sem default, lex C4).
        return;
      }
      await db.query(
        `INSERT INTO interview_invite_skips (worker_id, job_posting_id, domain_event_id, country, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [worker?.id ?? null, vacancy ? jobPostingId : null, domainEventId, country, reason],
      );
    };

    if (!vacancy) {
      await skip('VACANCY_NOT_FOUND');
      return;
    }

    const now = new Date();
    const offered = resolveOfferedSlots(vacancy, now);
    if (offered.length === 0) {
      await skip('NO_FUTURE_SLOT');
      return;
    }

    if (!worker) {
      await skip('WORKER_NOT_FOUND');
      return;
    }
    if (worker.status === 'DISABLED') {
      await skip('WORKER_DISABLED');
      return;
    }
    if (worker.opted_out) {
      await skip('OPT_OUT');
      return;
    }

    // Idempotência (lex C1): o slot recorrente nunca vence, então um 2º
    // `qualified` do mesmo par (bounce de etapa, re-sweep) repetiria a mensagem.
    const dup = await db.query<{ id: string }>(
      `SELECT id FROM messaging_outbox
       WHERE worker_id = $1 AND job_posting_id = $2 AND template_slug = 'qualified_worker_request'
         AND created_at > NOW() - INTERVAL '${INVITE_IDEMPOTENCY_WINDOW}'
       LIMIT 1`,
      [workerId, jobPostingId],
    );
    if (dup.rows.length > 0) {
      await skip('ALREADY_INVITED', { outboxId: dup.rows[0].id });
      return;
    }

    // O template aprovado na Meta tem 3 opções FIXAS no corpo e variável
    // vazia é rejeitado pelo WhatsApp (Twilio 'Content Variables parameter is
    // invalid'). Com menos de 3 slots, repete o último: qualquer botão agenda
    // um slot real (BookInterviewSlotUseCase cai no primeiro futuro).
    const last = offered[offered.length - 1];
    const outboxResult = await db.query(
      `INSERT INTO messaging_outbox (worker_id, job_posting_id, template_slug, variables, status, attempts)
       VALUES ($1, $2, 'qualified_worker_request', $3::jsonb, 'pending', 0)
       RETURNING id`,
      [
        workerId,
        jobPostingId,
        JSON.stringify({
          slot_1: offered[0].label,
          slot_2: (offered[1] ?? last).label,
          slot_3: (offered[2] ?? last).label,
          // '—' nunca acontece na prática (case_number é obrigatório na vaga) mas mantém o envio vivo.
          // D422 (24/09/2026): formatado (prefixo EN para caso nativo, ≥1000) — antes ia cru.
          case_number: formatCaseNumber(vacancy.case_number) ?? '—',
          job_posting_id: jobPostingId,
        }),
      ],
    );

    const outboxId = outboxResult.rows[0].id;
    await pubsub.publish('outbox-enqueued', { outboxId });

    await db.query(
      `UPDATE worker_job_applications
       SET interview_response = 'pending', updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );

    logger.info({
      msg: 'interview_invite.queued',
      workerId,
      jobPostingId,
      domainEventId,
      source,
      outboxId,
      slots: offered.map((s) => s.source),
    });
  };
}
