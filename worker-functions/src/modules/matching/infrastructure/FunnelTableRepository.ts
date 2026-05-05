import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

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
  // Latest whatsapp dispatch for this worker (regardless of vacancy, since
  // whatsapp_bulk_dispatch_logs has no job_posting_id column)
  wbdl_dispatched_at: string | null;
  wbdl_delivery_status: string | null;
  wbdl_status: string | null; // 'sent' | 'error'
}

/**
 * FunnelTableRepository
 *
 * Fetches all worker_job_applications for a given vacancy, joining:
 *  - workers: name (encrypted), email, phone, avatar (encrypted)
 *  - encuadres: raw_name fallback
 *  - whatsapp_bulk_dispatch_logs: most-recent dispatch per worker
 *
 * Note: whatsapp_bulk_dispatch_logs has no job_posting_id column (migration 062).
 * We therefore fetch the most-recent dispatch per worker across all campaigns.
 * This is the correct source of truth for whether a worker was ever messaged.
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
         latest_wbdl.dispatched_at::text                  AS wbdl_dispatched_at,
         latest_wbdl.delivery_status                      AS wbdl_delivery_status,
         latest_wbdl.status                               AS wbdl_status
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
         ORDER BY dispatched_at DESC
         LIMIT 1
       ) latest_wbdl ON true
       WHERE wja.job_posting_id = $1
       ORDER BY wja.created_at DESC NULLS LAST`,
      [jobPostingId],
    );

    return result.rows;
  }
}
