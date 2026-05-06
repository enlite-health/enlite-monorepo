import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { FunnelTableRepository, FunnelTableRawRow } from '../infrastructure/FunnelTableRepository';
import {
  FunnelTableRow,
  FunnelTableCounts,
  FunnelTableResult,
  FunnelBucket,
  WhatsAppStatus,
} from '../domain/FunnelTableRow';

// ── Bucket classification ────────────────────────────────────────────────────

const POSTULATED_STAGES = new Set(['INITIATED', 'IN_PROGRESS', 'COMPLETED']);
const PRE_SELECTED_STAGES = new Set(['QUALIFIED', 'CONFIRMED', 'SELECTED', 'PLACED']);
const REJECTION_STAGES = new Set(['REJECTED', 'NOT_QUALIFIED', 'RECHAZADO']);

/**
 * Classifies a row into one of the five named buckets.
 *
 * Withdrew takes precedence: interview_response='declined' OR stage='REPROGRAM'.
 */
function classifyBucket(row: FunnelTableRow): Exclude<FunnelBucket, 'ALL'> {
  const stage = row.funnelStage ?? '';
  const ir = row.interviewResponse ?? '';

  if (ir === 'declined' || stage === 'REPROGRAM') return 'WITHDREW';
  if (REJECTION_STAGES.has(stage)) return 'REJECTED';
  if (PRE_SELECTED_STAGES.has(stage)) return 'PRE_SELECTED';
  if (POSTULATED_STAGES.has(stage)) return 'POSTULATED';
  return 'INVITED'; // INVITED or unknown → INVITED
}

// ── WhatsApp status derivation ───────────────────────────────────────────────

/**
 * Derives the WhatsApp display status from a raw dispatch log row.
 *
 * Override rule: if worker already responded (interview_response in
 * {confirmed, declined, no_response, awaiting_reschedule, awaiting_reason}),
 * status = REPLIED, regardless of Twilio delivery status.
 */
function deriveWhatsAppStatus(row: FunnelTableRawRow): WhatsAppStatus | null {
  const ir = row.interview_response ?? '';

  // REPLIED override: any non-null, non-pending interview_response counts as
  // the worker having replied via WhatsApp.
  const replied = ['confirmed', 'declined', 'no_response', 'awaiting_reschedule', 'awaiting_reason'];
  if (replied.includes(ir)) return 'REPLIED';

  if (!row.wbdl_dispatched_at) return 'NOT_SENT';

  const deliveryStatus = (row.wbdl_delivery_status ?? '').toLowerCase();
  const status = (row.wbdl_status ?? '').toLowerCase();

  if (deliveryStatus === 'read') return 'READ';
  if (deliveryStatus === 'delivered') return 'DELIVERED';
  if (deliveryStatus === 'failed' || deliveryStatus === 'undelivered') return 'FAILED';
  if (status === 'error') return 'FAILED';
  return 'SENT'; // sent or no delivery update yet
}

// ── Main use case ────────────────────────────────────────────────────────────

export class GetFunnelTableUseCase {
  private repo: FunnelTableRepository;
  private encryption: KMSEncryptionService;

  constructor() {
    this.repo = new FunnelTableRepository();
    this.encryption = new KMSEncryptionService();
  }

  async execute(
    jobPostingId: string,
    bucket: FunnelBucket = 'ALL',
  ): Promise<FunnelTableResult> {
    const rawRows = await this.repo.fetchRawRows(jobPostingId);

    // Decrypt PII in parallel
    const rows = await Promise.all(
      rawRows.map(r => this.mapRow(r)),
    );

    // Build counts from ALL rows (regardless of bucket filter)
    const counts = this.buildCounts(rows);

    // Apply optional bucket filter to returned rows
    const filteredRows =
      bucket === 'ALL'
        ? rows
        : rows.filter(r => classifyBucket(r) === bucket);

    return { rows: filteredRows, counts };
  }

  private async mapRow(raw: FunnelTableRawRow): Promise<FunnelTableRow> {
    const [firstName, lastName, avatarUrl] = await Promise.all([
      this.encryption.decrypt(raw.first_name_encrypted ?? null),
      this.encryption.decrypt(raw.last_name_encrypted ?? null),
      this.encryption.decrypt(raw.profile_photo_url_encrypted ?? null),
    ]);

    const workerName =
      firstName || lastName
        ? [firstName, lastName].filter(Boolean).join(' ')
        : raw.worker_raw_name ?? null;

    const ir = raw.interview_response ?? null;
    const accepted =
      ir === 'confirmed' ? true :
      ir === 'declined'  ? false :
      null;

    return {
      id: raw.id,
      workerId: raw.worker_id,
      workerName,
      workerEmail: raw.email ?? null,
      workerPhone: raw.phone ?? null,
      workerAvatarUrl: avatarUrl ?? null,
      invitedAt: raw.invited_at,
      funnelStage: raw.funnel_stage ?? null,
      whatsappStatus: deriveWhatsAppStatus(raw),
      whatsappLastDispatchedAt: raw.wbdl_dispatched_at ?? null,
      accepted,
      interviewResponse: ir,
    };
  }

  private buildCounts(rows: FunnelTableRow[]): FunnelTableCounts {
    const counts: FunnelTableCounts = {
      INVITED: 0,
      POSTULATED: 0,
      PRE_SELECTED: 0,
      REJECTED: 0,
      WITHDREW: 0,
      ALL: rows.length,
    };
    for (const r of rows) {
      counts[classifyBucket(r)]++;
    }
    return counts;
  }
}
