import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { expandDocumentToken as expandDocumentTokenPure } from '@modules/worker/domain/documentTokenExpansion';
import { fetchWorkerDocumentRow } from '@modules/worker/infrastructure/WorkerCompletenessRepository';

export interface BlockedApplicationUpsertParams {
  workerId: string;
  jobPostingId: string;
  reason: 'worker_not_found' | 'registration_incomplete' | 'worker_disabled';
  acquisitionChannel: string | null;
}

export interface BlockedApplicationRow {
  id: string;
  worker_id: string;
  job_posting_id: string;
  blocked_reason: string;
  missing_fields: string[];
  attempt_count: number;
  first_attempted_at: Date;
  last_attempted_at: Date;
  acquisition_channel: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * BlockedApplicationRepository (write side)
 *
 * Persiste tentativas de postulação bloqueadas em worker_blocked_applications.
 * Invoca fn_worker_missing_fields() para popular missing_fields.
 *
 * CQRS leve: este repositório só escreve. Leitura via BlockedApplicationQueryRepository.
 *
 * Sem FK para workers/job_postings — tolera merges e soft-deletes.
 * Migration 209.
 */
export class BlockedApplicationRepository {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Expande o token grosso `worker_documents` para tokens específicos de documento.
   *
   * Busca (`fetchWorkerDocumentRow`) e regra pura (`expandDocumentTokenPure`) vivem em
   * `worker/domain/documentTokenExpansion.ts` — ponto ÚNICO, reusado pelo
   * `GET /api/workers/me` (`WorkerCompletenessRepository.readWorkerMissingFields`),
   * desde a Fase 1 de `postulacao-documento-pendente` (DD1). Este método só resolve
   * o `workerId` da instância e trata a falha de forma NÃO-FATAL — mesmo comportamento
   * de antes da extração.
   *
   * Se `worker_documents` não estiver em missingFields, retorna missingFields sem alteração
   * (checagem redundante com a de `expandDocumentTokenPure`, mas evita a query quando óbvio
   * que não é necessária).
   *
   * Escolha de armazenamento: o banco continua gravando o token cru `worker_documents`
   * (para manter compatibilidade com queries analíticas/existentes). O retorno do método
   * é sempre o array EXPANDIDO (com doc_*), usado pelo controller no 403.
   */
  private async expandDocumentToken(
    workerId: string,
    missingFields: string[],
  ): Promise<string[]> {
    if (!missingFields.includes('worker_documents')) {
      return missingFields;
    }

    const log = logger.child({ workerId });

    try {
      const row = await fetchWorkerDocumentRow(this.pool, workerId);
      return expandDocumentTokenPure(missingFields, row);
    } catch (err) {
      log.warn({
        msg: 'BlockedApplicationRepository.expandDocumentToken: failed to expand doc token (non-fatal)',
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: return raw fields unchanged
      return missingFields;
    }
  }

  /**
   * Upsert de tentativa bloqueada.
   *
   * - Na primeira tentativa: INSERT com attempt_count=1.
   * - Em retentativas: incrementa attempt_count, atualiza last_attempted_at,
   *   recalcula missing_fields, preserva acquisition_channel (first-value-wins).
   *
   * Retorna os missingFields EXPANDIDOS (doc_* em vez de worker_documents) para
   * uso no corpo do 403. O banco grava o array cru (com worker_documents) para
   * manter compatibilidade com queries analíticas existentes.
   */
  async upsert(params: BlockedApplicationUpsertParams): Promise<string[]> {
    const log = logger.child({
      workerId: params.workerId,
      jobPostingId: params.jobPostingId,
      reason: params.reason,
    });

    // Calcula missing_fields via SSOT SQL para worker_not_found e registration_incomplete.
    // Para worker_disabled retorna [] (worker existe mas está desabilitado — campos irrelevantes).
    let missingFields: string[] = [];
    if (params.reason !== 'worker_disabled') {
      const { rows } = await this.pool.query<{ missing: string[] }>(
        `SELECT fn_worker_missing_fields($1)::text AS missing`,
        [params.workerId],
      );
      const raw = rows[0]?.missing;
      if (typeof raw === 'string') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            missingFields = parsed.filter((v): v is string => typeof v === 'string');
          }
        } catch {
          log.warn({ msg: 'BlockedApplicationRepository: failed to parse fn_worker_missing_fields result', raw });
        }
      } else if (Array.isArray(raw)) {
        missingFields = (raw as unknown[]).filter((v): v is string => typeof v === 'string');
      }
    }

    // Grava o array cru (pode conter `worker_documents`) para compatibilidade com
    // queries analíticas e a coluna missing_fields existente.
    await this.pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason, missing_fields, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         attempt_count        = worker_blocked_applications.attempt_count + 1,
         last_attempted_at    = NOW(),
         missing_fields       = EXCLUDED.missing_fields,
         blocked_reason       = EXCLUDED.blocked_reason,
         acquisition_channel  = COALESCE(
                                  worker_blocked_applications.acquisition_channel,
                                  EXCLUDED.acquisition_channel
                                ),
         updated_at           = NOW()`,
      [
        params.workerId,
        params.jobPostingId,
        params.reason,
        JSON.stringify(missingFields),
        params.acquisitionChannel,
      ],
    );

    log.info({
      msg: 'BlockedApplicationRepository.upsert: blocked attempt recorded',
      missingFieldsCount: missingFields.length,
    });

    // Expande worker_documents → doc_* tokens para o corpo do 403.
    const expanded = await this.expandDocumentToken(params.workerId, missingFields);
    return expanded;
  }

  /**
   * "Rechazar" (soft-dismiss) uma tentativa bloqueada — o botão da coluna BLOQUEADO.
   *
   * Não cria WJA: o trigger 183 (enforce_worker_registered_for_application) proíbe
   * candidatura de worker não-REGISTERED, e todo bloqueado é não-REGISTERED. Então só
   * marca dismissed_at + dismissed_reason: o card sai de BLOQUEADO e passa a aparecer
   * em RECHAZADOS como card de bloqueado (não-arrastável). Reversível via undismiss.
   *
   * Retorna true se marcou; false se o id não existe (→ 404 no controller).
   */
  async dismiss(id: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE worker_blocked_applications
       SET dismissed_at = NOW(), dismissed_reason = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, reason],
    );
    const ok = (result.rowCount ?? 0) > 0;
    logger.info({ msg: 'BlockedApplicationRepository.dismiss: blocked attempt dismissed', blockedApplicationId: id, reason, ok });
    return ok;
  }

  /**
   * "Voltar a bloqueados" — desfaz o rechazo (limpa dismissed_at/reason). O card
   * volta de RECHAZADOS para BLOQUEADO (único destino válido para um incompleto).
   * Retorna true se desfez; false se o id não existe.
   */
  async undismiss(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE worker_blocked_applications
       SET dismissed_at = NULL, dismissed_reason = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
    const ok = (result.rowCount ?? 0) > 0;
    logger.info({ msg: 'BlockedApplicationRepository.undismiss: blocked attempt restored', blockedApplicationId: id, ok });
    return ok;
  }
}
