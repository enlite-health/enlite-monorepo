import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  deadlineDateOf,
  sortKinds,
  type ContactStatusKind,
  type ContactStatusValue,
  type ContactStatusView,
} from '../domain/TherapeuticContactStatus';

/** Linha de status como o repositório de escrita a conhece (com o uid de quem marcou — NUNCA sai na API). */
export interface ContactStatusRow {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  /** `null` em `NOT_NEEDED`. */
  pendingSince: Date | null;
  markedByUid: string;
}

/** O que `insertStatuses` grava: `pendingSince: null` + PENDING = "agora" (do Postgres, o mesmo `now()` da versão). */
export interface ContactStatusInsert {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  pendingSince: Date | null;
  markedByUid: string;
}

interface StatusDbRow {
  version_id: string;
  contact_kind: ContactStatusKind;
  status: ContactStatusValue;
  pending_since: Date | string | null;
  marked_by_uid: string;
}

const toDate = (v: Date | string | null): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

/**
 * Status por campo de contato do PT (migration 502). A escrita só existe na transação que cria a versão
 * (trigger `fn_ptpcs_imutavel`), DEPOIS dos contatos (o trigger recusa status + contato no mesmo campo).
 */
export class TherapeuticProjectContactStatusRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async listByVersions(versionIds: readonly string[], cli: Pool | PoolClient = this.pool): Promise<Map<string, ContactStatusRow[]>> {
    const out = new Map<string, ContactStatusRow[]>();
    if (versionIds.length === 0) return out;
    const { rows } = await cli.query<StatusDbRow>(
      `SELECT version_id, contact_kind, status, pending_since, marked_by_uid
         FROM patient_therapeutic_project_contact_status
        WHERE version_id = ANY($1::uuid[])`,
      [versionIds],
    );
    for (const r of rows) {
      const list = out.get(r.version_id) ?? [];
      list.push({ kind: r.contact_kind, status: r.status, pendingSince: toDate(r.pending_since), markedByUid: r.marked_by_uid });
      out.set(r.version_id, list);
    }
    return out;
  }

  async insertStatuses(cli: PoolClient, versionId: string, patientId: string, rows: readonly ContactStatusInsert[]): Promise<void> {
    for (const r of rows) {
      await cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status
           (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text = 'PENDING' THEN COALESCE($5::timestamptz, now()) END, $6)`,
        [versionId, patientId, r.kind, r.status, r.pendingSince, r.markedByUid],
      );
    }
  }
}

/**
 * Projeção para a API: ordem fixa dos campos; vencimento = dia local de `pendingSince` + 15. Sem `markedByUid`
 * (nenhum uid de colaborador sai — `therapeuticProjectAccess`).
 */
export function toContactStatusViews(rows: readonly ContactStatusRow[], country: string): ContactStatusView[] {
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return sortKinds([...byKind.keys()]).map((kind) => {
    const r = byKind.get(kind) as ContactStatusRow;
    return {
      kind,
      status: r.status,
      pendingSince: r.pendingSince ? r.pendingSince.toISOString() : null,
      deadlineDate: r.status === 'PENDING' && r.pendingSince ? deadlineDateOf(r.pendingSince, country) : null,
    };
  });
}
