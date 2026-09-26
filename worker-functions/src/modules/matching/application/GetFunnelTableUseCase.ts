import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { FunnelTableRepository, FunnelTableRawRow } from '../infrastructure/FunnelTableRepository';
import {
  FunnelTableRow,
  FunnelTableCounts,
  FunnelTableResult,
  FunnelBucket,
  WhatsAppStatus,
} from '../domain/FunnelTableRow';
import { cellsOfRequest, projectWorkerFields } from '@modules/identity/permissions';
import {
  POSTULATED_STAGES_SET,
  PRE_SELECTED_STAGES_SET,
  REJECTION_STAGES_SET,
} from '../domain/applicationFunnelStages';
import {
  deriveKanbanColumn,
  isMatchedNotInvited,
  tallyKanbanColumns,
  emptyFunnelColumnCounts,
  KANBAN_COLUMN_BLOCKED,
  type KanbanColumn,
  type KanbanTallyRow,
} from '../domain/kanbanColumn';

// ── Bucket classification ────────────────────────────────────────────────────

/**
 * Classifies a row into one of the five named buckets.
 *
 * Withdrew takes precedence: interview_response='declined'.
 * Workers em CONFIRMED+awaiting_reschedule+meet_link=NULL pertencem a PRE_SELECTED (F7.b — ADR-003).
 * REPROGRAM removido em F7.b — não existe mais como stage válido.
 */
function classifyBucket(row: FunnelTableRow): Exclude<FunnelBucket, 'ALL'> {
  const stage = row.funnelStage ?? '';
  const ir = row.interviewResponse ?? '';

  if (ir === 'declined') return 'WITHDREW';
  if (REJECTION_STAGES_SET.has(stage)) return 'REJECTED';
  if (PRE_SELECTED_STAGES_SET.has(stage)) return 'PRE_SELECTED';
  if (POSTULATED_STAGES_SET.has(stage)) return 'POSTULATED';
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

  /**
   * @param cells células do ator (F2/C3), vindas de `cellsOfRequest(req)`.
   *   `null` = o engine não decidiu nesta request → a projeção devolve o que
   *   esta rota já devolvia (D113). **Nunca `[]` por omissão** — `[]` é ator
   *   conhecido e sem célula, e redige o nome de todo mundo.
   */
  async execute(
    jobPostingId: string,
    bucket: FunnelBucket = 'ALL',
    cells: string[] | null = null,
    columns: string[] | null = null,
  ): Promise<FunnelTableResult> {
    const [rawRows, blockedRawRows] = await Promise.all([
      this.repo.fetchRawRows(jobPostingId),
      this.repo.fetchBlockedRawRows(jobPostingId),
    ]);

    // F2/C3: a projeção decide ANTES do KMS — ver projectWorkerFields. A tentativa
    // negada passa pela MESMA projeção (não pula o KMS por ser um caminho diferente).
    const rows = await Promise.all(rawRows.map(r => this.mapRow(r, cells)));
    const blockedRows = await Promise.all(blockedRawRows.map(r => this.mapRow(r, cells)));

    // Contagem por bucket: só WJA, igual a hoje (D437 — a Gestão à Vista não muda).
    const counts = this.buildCounts(rows);
    // Contagem por coluna do Kanban (DX-2.6): WJA ∪ tentativa negada, MESMO SSOT do
    // board (tallyKanbanColumns), a partir das linhas cruas (stage/source/messaged).
    const wjaTallyRows: KanbanTallyRow[] = rawRows.map(r => ({
      kind: 'wja',
      stage: r.funnel_stage,
      source: r.source,
      messaged: r.messaged_at != null,
      n: 1,
    }));
    const blockedTallyRows: KanbanTallyRow[] = blockedRawRows.map(() => ({
      kind: 'blocked',
      stage: null,
      source: null,
      messaged: false,
      n: 1,
    }));
    counts.columns = tallyKanbanColumns([...wjaTallyRows, ...blockedTallyRows]);

    // Com `columns`: filtra WJA ∪ bloqueadas pela coluna derivada (a tentativa negada
    // só aparece quando o filtro inclui REJECTED). Sem `columns`: o filtro de bucket
    // de hoje, só sobre WJA — bloqueadas nunca entram em `bucket=ALL`.
    const filteredRows = columns
      ? [...rows, ...blockedRows].filter(r => r.kanbanColumn != null && columns.includes(r.kanbanColumn))
      : bucket === 'ALL'
        ? rows
        : rows.filter(r => classifyBucket(r) === bucket);

    return { rows: filteredRows, counts };
  }

  private async mapRow(raw: FunnelTableRawRow, cells: string[] | null): Promise<FunnelTableRow> {
    // ⚠️ `worker_raw_name` entra como `rawName` NA PROJEÇÃO, e não como
    // fallback aqui fora: é texto claro, e um `|| raw.worker_raw_name` depois
    // da projeção devolveria o nome de todo card legado sem tocar o KMS — sem o
    // espião ver nada.
    // ⚠️ A FOTO é dossiê (D168), não contato: sai só com `worker_pii:read`.
    const visivel = await projectWorkerFields(cells, {
      firstNameEncrypted: raw.first_name_encrypted ?? null,
      lastNameEncrypted: raw.last_name_encrypted ?? null,
      rawName: raw.worker_raw_name ?? null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      profilePhotoUrlEncrypted: raw.profile_photo_url_encrypted ?? null,
    }, this.encryption);

    const workerName = visivel.name ?? null;

    const ir = raw.interview_response ?? null;
    const accepted =
      ir === 'confirmed' ? true :
      ir === 'declined'  ? false :
      null;

    // Mesma classificação do Kanban da vaga (SSOT em kanbanColumn.ts): tentativa
    // negada = KANBAN_COLUMN_BLOCKED (REJECTED, D433); match candidate nunca
    // mensageado fica de fora do board (null); o resto segue deriveKanbanColumn.
    const kanbanColumn: Exclude<KanbanColumn, 'BLOQUEADO'> | null = raw.is_blocked
      ? (KANBAN_COLUMN_BLOCKED as Exclude<KanbanColumn, 'BLOQUEADO'>)
      : isMatchedNotInvited(raw.funnel_stage, raw.source, raw.messaged_at)
        ? null
        : (deriveKanbanColumn(raw.funnel_stage, raw.source) as Exclude<KanbanColumn, 'BLOQUEADO'>);

    return {
      id: raw.id,
      workerId: raw.worker_id,
      workerName,
      workerEmail: visivel.email ?? null,
      workerPhone: visivel.phone ?? null,
      workerAvatarUrl: visivel.profilePhotoUrl ?? null,
      invitedAt: raw.invited_at,
      funnelStage: raw.funnel_stage ?? null,
      whatsappStatus: deriveWhatsAppStatus(raw),
      whatsappLastDispatchedAt: raw.wbdl_dispatched_at ?? null,
      accepted,
      interviewResponse: ir,
      registrationComplete: raw.worker_status === 'REGISTERED',
      contactNotesCount: Number(raw.contact_notes_count ?? 0),
      selfAppliedAt: raw.self_applied_at ?? null,
      kanbanColumn,
      isBlocked: raw.is_blocked,
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
      columns: emptyFunnelColumnCounts(),
    };
    for (const r of rows) {
      counts[classifyBucket(r)]++;
    }
    return counts;
  }
}
