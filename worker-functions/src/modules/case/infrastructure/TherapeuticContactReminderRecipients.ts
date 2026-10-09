import type { Pool, PoolClient } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { sortKinds, type ContactStatusKind } from '../domain/TherapeuticContactStatus';
import { PT_INCOMPLETE_ALERT_CELL } from '../application/therapeuticProjectAccess';
import type { ContactStatusRow } from './TherapeuticProjectContactStatusRepository';

export interface ReminderRecipient {
  uid: string;
  /** Os campos que ESTE destinatário vê no aviso. */
  fields: ContactStatusKind[];
}

/**
 * Quem recebe o aviso do ciclo (spec 048, arquitetura §5 / respostas de 08/10):
 *  · dias 2 e 5: cada operador que marcou um campo AINDA pendente, pelos campos dele;
 *  · dia 12: os de cima MAIS todo staff vivo com a célula `patient_therapeutic_project:incomplete_alert` — estes
 *    veem todos os campos pendentes (o código decide por CÉLULA, nunca por nome de grupo);
 *  · um uid aparece uma vez (quem é as duas coisas recebe todos os campos); staff inativo fica fora.
 * A consulta por célula é `iam.effective_permissions` (o job não é request) e o filtro é feito em TS por
 * `cells.includes(...)` — é isso que faz o scanner do catálogo enxergar o consumidor da célula.
 */
export class TherapeuticContactReminderRecipients {
  async resolve(
    cli: Pool | PoolClient,
    pending: readonly ContactStatusRow[],
    includeIncompleteAlert: boolean,
  ): Promise<ReminderRecipient[]> {
    const pendingKinds = sortKinds(pending.filter((p) => p.status === 'PENDING').map((p) => p.kind));
    if (pendingKinds.length === 0) return [];

    const byOperator = new Map<string, ContactStatusKind[]>();
    for (const p of pending) {
      if (p.status !== 'PENDING') continue;
      byOperator.set(p.markedByUid, [...(byOperator.get(p.markedByUid) ?? []), p.kind]);
    }

    const live = await this.liveStaffUids(cli, [...byOperator.keys()]);
    const result = new Map<string, ContactStatusKind[]>();
    for (const [uid, kinds] of byOperator) {
      if (live.has(uid)) result.set(uid, sortKinds(kinds));
    }

    if (includeIncompleteAlert) {
      const staff = await cli.query<{ uid: string; cells: string[] | null }>(
        `SELECT u.firebase_uid AS uid, iam.effective_permissions(u.firebase_uid, $1::uuid) AS cells
           FROM users u
          WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE`,
        [ENLITE_TENANT_ID],
      );
      for (const s of staff.rows) {
        const cells = s.cells ?? [];
        if (cells.includes(PT_INCOMPLETE_ALERT_CELL)) result.set(s.uid, pendingKinds);
      }
    }
    return [...result.entries()].map(([uid, fields]) => ({ uid, fields }));
  }

  private async liveStaffUids(cli: Pool | PoolClient, uids: string[]): Promise<Set<string>> {
    if (uids.length === 0) return new Set();
    const { rows } = await cli.query<{ uid: string }>(
      `SELECT firebase_uid AS uid FROM users WHERE firebase_uid = ANY($1::text[]) AND status = 'ACTIVE' AND is_active IS NOT FALSE`,
      [uids],
    );
    return new Set(rows.map((r) => r.uid));
  }
}
