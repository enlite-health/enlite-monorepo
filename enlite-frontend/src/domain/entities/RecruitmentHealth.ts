/**
 * RecruitmentHealth domain entities
 *
 * Matches the shape returned by GET /api/admin/recruitment/health
 */

export interface AutoInviteLast24h {
  vacancies_created: number;
  invites_enqueued: number;
  invites_sent: number;
  invites_delivered: number;
  invites_failed: number;
}

export interface BulkRun {
  batch_id: string | null;
  total: number;
  sent: number;
  errors: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface RecruitmentHealthData {
  auto_invite_last_24h: AutoInviteLast24h;
  bulk_dispatch_incomplete_last_run: BulkRun;
  bulk_dispatch_talentum_last_run: BulkRun;
}
