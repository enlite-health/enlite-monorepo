/**
 * src/shared/messaging/WorkerMessageAuditRepository.ts
 *
 * Ponto único de escrita em `worker_message_audit` (migration 474) — a tabela
 * que grava o estado do worker NO INSTANTE em que o sistema decide enviar,
 * enfileirar, pular ou falhar um disparo de WhatsApp. Não é a trilha de
 * entrega (isso continua em `messaging_outbox` / `whatsapp_bulk_dispatch_logs`
 * / `funnel_stage_message_log`, nenhuma delas alterada por este repositório).
 *
 * Ver openspec/changes/log-auditoria-mensageria/{proposal,design}.md.
 *
 * Best-effort: uma falha aqui NUNCA derruba o fluxo de mensageria que está
 * auditando — mesmo padrão `.catch()` + `logger.warn` + `reportError` já
 * usado nos 15 pontos de escrita de messaging_outbox/whatsapp_bulk_dispatch_logs
 * /funnel_stage_message_log hoje existentes. `record()` nunca lança para o
 * caller: o try/catch é INTERNO, não uma responsabilidade do chamador.
 *
 * Aceita Pool OU PoolClient: quando o caller já está dentro de uma transação
 * (ex.: StageMessageHandler, C3 com advisory lock), passar o MESMO client
 * garante que a linha de auditoria reverte junto se a transação principal
 * reverter — passar `db` (Pool) ali confirmaria um outbox_id que a transação
 * ainda pode desfazer.
 */

import type { Pool, PoolClient } from 'pg';
import { logger, reportError } from '@shared/logging';

/** União dos domínios já vivos em whatsapp_bulk_dispatch_logs.source e funnel_stage_message_log.source. */
export type WorkerMessageAuditSource =
  | 'bulk'
  | 'individual'
  | 'outbox'
  | 'kanban'
  | 'talentum'
  | 'system';

/** Mesmo domínio de messaging_outbox.channel (migration 241). */
export type WorkerMessageAuditChannel = 'twilio' | 'periskope';

/** Mesmo domínio de workers.status relevante para decisão de template. */
export type WorkerStatusAtDispatch = 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED';

/** Mesmo domínio de worker_documents.documents_status (CONSTRAINT valid_documents_status). */
export type DocumentsStatusAtDispatch =
  | 'pending'
  | 'incomplete'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected';

export type WorkerMessageAuditOutcome = 'queued' | 'sent' | 'skipped' | 'failed';

const WORKER_STATUS_AT_DISPATCH_VALUES: readonly WorkerStatusAtDispatch[] = [
  'REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED',
];

const DOCUMENTS_STATUS_AT_DISPATCH_VALUES: readonly DocumentsStatusAtDispatch[] = [
  'pending', 'incomplete', 'submitted', 'under_review', 'approved', 'rejected',
];

/**
 * Guarda de domínio: caller lê `workers.status`/`worker_documents.documents_status` de uma
 * query já existente (valor livre em runtime, não um enum TS) e precisa confirmar que bate
 * com o CHECK de `worker_message_audit` ANTES de passar pro repositório — evita depender só
 * do catch best-effort do INSERT pra um valor fora do domínio (ex.: status legado/futuro).
 */
export function isWorkerStatusAtDispatch(value: string | null | undefined): value is WorkerStatusAtDispatch {
  return !!value && (WORKER_STATUS_AT_DISPATCH_VALUES as readonly string[]).includes(value);
}

export function isDocumentsStatusAtDispatch(value: string | null | undefined): value is DocumentsStatusAtDispatch {
  return !!value && (DOCUMENTS_STATUS_AT_DISPATCH_VALUES as readonly string[]).includes(value);
}

export interface WorkerMessageAuditParams {
  /** Só UUID — nunca nome, telefone ou e-mail (ver spec.md, Requirement de não-PII). */
  workerId: string | null;
  jobPostingId?: string | null;
  templateSlug: string;
  channel?: WorkerMessageAuditChannel | null;
  source: WorkerMessageAuditSource;
  actorUid?: string | null;
  traceId?: string | null;
  /** Snapshot em memória — nunca uma releitura de `workers.status` depois da decisão. */
  workerStatusAtDispatch?: WorkerStatusAtDispatch | null;
  documentsStatusAtDispatch?: DocumentsStatusAtDispatch | null;
  /** Slugs de workerDocumentPolicy.getRequiredSlugs() — nunca prosa. */
  missingDocuments?: string[];
  outcome: WorkerMessageAuditOutcome;
  skipReason?: string | null;
}

export class WorkerMessageAuditRepository {
  async record(client: Pool | PoolClient, params: WorkerMessageAuditParams): Promise<void> {
    try {
      await client.query(
        `INSERT INTO worker_message_audit
           (worker_id, job_posting_id, template_slug, channel, source, actor_uid, trace_id,
            worker_status_at_dispatch, documents_status_at_dispatch, missing_documents,
            outcome, skip_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          params.workerId,
          params.jobPostingId ?? null,
          params.templateSlug,
          params.channel ?? null,
          params.source,
          params.actorUid ?? null,
          params.traceId ?? null,
          params.workerStatusAtDispatch ?? null,
          params.documentsStatusAtDispatch ?? null,
          params.missingDocuments ?? [],
          params.outcome,
          params.skipReason ?? null,
        ],
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        {
          error: error.message,
          templateSlug: params.templateSlug,
          source: params.source,
          outcome: params.outcome,
          workerId: params.workerId,
        },
        'Falha ao gravar worker_message_audit',
      );
      reportError(error, {
        source: 'WorkerMessageAuditRepository.record',
        templateSlug: params.templateSlug,
        auditSource: params.source,
      });
    }
  }
}
