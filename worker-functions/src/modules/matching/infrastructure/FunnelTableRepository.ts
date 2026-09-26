import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { liveWorkerJoinSql } from './blockedAttemptLiveState';
import { blockedNotPromotedSql } from './BlockedApplicationQueryRepository';

/**
 * Raw database row returned by the funnel-table query (before domain mapping).
 */
export interface FunnelTableRawRow {
  id: string;
  worker_id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  worker_raw_name: string | null;
  email: string | null;
  phone: string | null;
  profile_photo_url_encrypted: string | null;
  invited_at: string;
  funnel_stage: string | null;
  interview_response: string | null;
  // Latest whatsapp dispatch for this worker AT this vacancy.
  // job_posting_id passou a ser preenchido pelos inserters vacancy-scoped
  // (OutboxProcessor, MessagingController.sendToWorker) na migration 181.
  wbdl_dispatched_at: string | null;
  wbdl_delivery_status: string | null;
  wbdl_status: string | null; // 'sent' | 'error'
  worker_status: string | null;
  contact_notes_count: number | string | null;
  /**
   * Quando o PRÓPRIO prestador criou/mexeu nesta candidatura (clicou no link da
   * vaga e entrou sozinho). Vem do trigger de histórico com ator `worker_self:`
   * (D95). NULL = não sabemos — a autoria só passou a ser gravada em 06/08, e
   * card antigo sem carimbo NÃO significa que a pessoa não se manifestou.
   */
  self_applied_at: string | null;
  /** worker_job_applications.source — 'manual' entra em INICIADO, o resto em INVITED. */
  source: string | null;
  /** worker_job_applications.messaged_at — distingue match candidate de convite real. */
  messaged_at: string | null;
  /** true quando a linha veio de worker_blocked_applications (fetchBlockedRawRows), não de WJA. */
  is_blocked: boolean;
}

/**
 * FunnelTableRepository
 *
 * Fetches all worker_job_applications for a given vacancy, joining:
 *  - workers: name (encrypted), email, phone, avatar (encrypted)
 *  - encuadres: raw_name fallback
 *  - whatsapp_bulk_dispatch_logs: most-recent dispatch per (worker, vacancy)
 *
 * Filtra pelo par (worker_id, job_posting_id) — dispatchs sem vaga
 * (sendDirect, bulk reminders) não interferem no status da aba "Invitados".
 */
export class FunnelTableRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async fetchRawRows(jobPostingId: string): Promise<FunnelTableRawRow[]> {
    const result = await this.pool.query<FunnelTableRawRow>(
      `SELECT
         wja.id,
         wja.worker_id,
         w.first_name_encrypted,
         w.last_name_encrypted,
         e.worker_raw_name,
         w.email,
         w.phone,
         w.profile_photo_url_encrypted,
         COALESCE(wja.created_at, wja.messaged_at)::text  AS invited_at,
         wja.application_funnel_stage                      AS funnel_stage,
         wja.interview_response,
         wja.source,
         wja.messaged_at::text                             AS messaged_at,
         false                                              AS is_blocked,
         latest_wbdl.dispatched_at::text                  AS wbdl_dispatched_at,
         latest_wbdl.delivery_status                      AS wbdl_delivery_status,
         latest_wbdl.status                               AS wbdl_status,
         w.status                                          AS worker_status,
         (SELECT COUNT(*)::int FROM wja_contact_notes cn
          WHERE cn.worker_id = wja.worker_id AND cn.job_posting_id = wja.job_posting_id) AS contact_notes_count,
         -- "Levantou a mão": o próprio prestador entrou na vaga pelo link público
         -- (track-channel → ator worker_self: no trigger, D95). Sinal de lead QUENTE —
         -- sem isso o card fica idêntico a um convite frio e a pessoa espera em
         -- silêncio (caso Carina, 14 vagas em 3 semanas). NULL = não sabemos: a
         -- autoria só é gravada desde 06/08.
         -- Subquery escalar (e não LATERAL) de propósito: o meta-teste sql-schema-sync
         -- não distingue alias de LATERAL de nome de tabela, e abrir exceção pra ele
         -- enfraquece um guard que já pegou schema drift de verdade.
         (SELECT h.created_at::text FROM worker_job_application_stage_history h
           WHERE h.application_id = wja.id AND h.changed_by LIKE 'worker_self:%'
           ORDER BY h.created_at ASC LIMIT 1)               AS self_applied_at
       FROM worker_job_applications wja
       LEFT JOIN workers w
         ON w.id = wja.worker_id
       LEFT JOIN LATERAL (
         SELECT worker_raw_name
         FROM encuadres
         WHERE worker_id = wja.worker_id
           AND job_posting_id = wja.job_posting_id
         ORDER BY created_at DESC
         LIMIT 1
       ) e ON true
       LEFT JOIN LATERAL (
         SELECT dispatched_at, delivery_status, status
         FROM whatsapp_bulk_dispatch_logs
         WHERE worker_id = wja.worker_id
           AND job_posting_id = wja.job_posting_id
         ORDER BY dispatched_at DESC
         LIMIT 1
       ) latest_wbdl ON true
       WHERE wja.job_posting_id = $1
         -- Worker que deu baixa na conta some do kanban (linhas E contadores das
         -- abas, que o GetFunnelTableUseCase deriva destas linhas).
         AND ${excludeDisabledWorkersSql('w')}
       ORDER BY wja.created_at DESC NULLS LAST`,
      [jobPostingId],
    );

    return result.rows;
  }

  /**
   * Tentativas negadas (worker_blocked_applications) não promovidas, para a tabela
   * do modo lista — mesmo shape de linha de fetchRawRows, para o mapper (P8) tratar
   * as duas fontes de forma uniforme. Só aparecem quando o filtro `columns` inclui
   * REJECTED (D433) — não entram no bucket 'ALL' de hoje.
   */
  async fetchBlockedRawRows(jobPostingId: string): Promise<FunnelTableRawRow[]> {
    const result = await this.pool.query<FunnelTableRawRow>(
      `SELECT wba.id, wba.worker_id, lw.first_name_encrypted, lw.last_name_encrypted, NULL::text AS worker_raw_name, lw.email,
lw.phone, lw.profile_photo_url_encrypted, wba.last_attempted_at::text AS invited_at, NULL::text AS funnel_stage,
NULL::text AS interview_response, NULL::text AS wbdl_dispatched_at, NULL::text AS wbdl_delivery_status,
NULL::text AS wbdl_status, lw.status AS worker_status, (SELECT COUNT(*)::int FROM wja_contact_notes cn WHERE
cn.worker_id = wba.worker_id AND cn.job_posting_id = wba.job_posting_id) AS contact_notes_count, NULL::text AS
self_applied_at, NULL::text AS source, NULL::text AS messaged_at, true AS is_blocked FROM worker_blocked_applications wba
${liveWorkerJoinSql()} WHERE wba.job_posting_id = $1 AND ${blockedNotPromotedSql('wba')} ORDER BY wba.last_attempted_at DESC`,
      [jobPostingId],
    );

    return result.rows;
  }
}
