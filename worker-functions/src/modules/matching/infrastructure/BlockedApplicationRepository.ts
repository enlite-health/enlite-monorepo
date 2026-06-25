import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';

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

/** Maps worker_documents SQL column names to their doc_* tokens. */
const DOC_COLUMN_TO_TOKEN: Record<string, string> = {
  resume_cv_url: 'doc_resume_cv',
  identity_document_url: 'doc_identity_document',
  criminal_record_url: 'doc_criminal_record',
  at_certificate_url: 'doc_at_certificate',
};

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
   * Semântica de profession IS NULL: espelha EXATAMENTE o gate SQL fn_worker_missing_fields
   * (migration 212, linhas 209-220). No SQL, `profession != 'AT'` com NULL retorna NULL
   * (não-TRUE), portanto a condição OR só passa se resume_cv+at_certificate estiverem
   * ambos presentes — ou seja, profession NULL é tratado como AT para fins de documentos.
   * DIVERGÊNCIA com workerDocumentPolicy.ts (UNKNOWN→BASE apenas): não usamos o helper TS
   * para este método porque a paridade com o SQL é requisito explícito da spec.
   *
   * Se `worker_documents` não estiver em missingFields, retorna missingFields sem alteração.
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
      const { rows } = await this.pool.query<{
        profession: string | null;
        resume_cv_url: string | null;
        identity_document_url: string | null;
        criminal_record_url: string | null;
        at_certificate_url: string | null;
      }>(
        `SELECT
           w.profession,
           wd.resume_cv_url,
           wd.identity_document_url,
           wd.criminal_record_url,
           wd.at_certificate_url
         FROM workers w
         LEFT JOIN worker_documents wd ON wd.worker_id = w.id
         WHERE w.id = $1
           AND w.merged_into_id IS NULL`,
        [workerId],
      );

      if (rows.length === 0) {
        // Worker not found or merged — keep raw token, return as-is
        return missingFields;
      }

      const row = rows[0];
      const profession = row.profession;

      // Determine required columns per SQL gate semantics:
      //   - profession = 'AT': identity_document_url + criminal_record_url + resume_cv_url + at_certificate_url
      //   - profession IS NULL or '': treat as AT (NULL != 'AT' is NULL in SQL → OR branch
      //     only passes when both resume_cv and at_certificate are present)
      //   - profession != 'AT' (non-null, non-empty): identity_document_url + criminal_record_url only
      const isAtOrUnknown = profession === 'AT' || profession === null || profession === '';
      const requiredColumns = isAtOrUnknown
        ? ['identity_document_url', 'criminal_record_url', 'resume_cv_url', 'at_certificate_url']
        : ['identity_document_url', 'criminal_record_url'];

      const missingDocTokens = requiredColumns
        .filter(col => row[col as keyof typeof row] === null)
        .map(col => DOC_COLUMN_TO_TOKEN[col])
        .filter((t): t is string => t !== undefined);

      // Replace `worker_documents` with specific doc_* tokens
      const expanded = missingFields
        .filter(f => f !== 'worker_documents')
        .concat(missingDocTokens);

      return expanded;
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
}
