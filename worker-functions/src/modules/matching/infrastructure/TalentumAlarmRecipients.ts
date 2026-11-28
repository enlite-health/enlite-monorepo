import type { PoolClient } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';

export interface TalentumAlarmRecipientSet {
  /** Quem recebe: staff ATIVO com a célula `talentum:update` (Recrutamento) ∪ membro vivo do Acesso Master. */
  uids: string[];
  /** Quantos têm a célula (sem contar o Master): 0 = a coordenação ainda não tem grupo/membro (a operação decide; aqui só se avisa). */
  withCell: number;
}

export interface ITalentumAlarmRecipients {
  resolve(c: PoolClient): Promise<TalentumAlarmRecipientSet>;
}

/**
 * Destinatários do sino do webhook do Talentum (spec 095 §13.4): coordenação de Recrutamento + Master. "Recrutamento" é o recurso
 * `talentum` do catálogo; quem gere a integração tem `talentum:update` (publicar/sincronizar com o Talentum). Filtro em TS por
 * `cells.includes(...)` (molde `UncoveredAlertRecipients`), para o scanner do catálogo enxergar o consumidor da célula. Nenhum grupo é
 * criado nem alterado: quem recebe é decisão da operação, ao dar a célula. Roda no `client` da transação do aviso.
 */
export class TalentumAlarmRecipients implements ITalentumAlarmRecipients {
  async resolve(c: PoolClient): Promise<TalentumAlarmRecipientSet> {
    const { rows } = await c.query<{ uid: string; cells: string[] | null; master: boolean | null }>(
      `SELECT u.firebase_uid AS uid,
              iam.effective_permissions(u.firebase_uid, $1::uuid) AS cells,
              iam.is_master_member(u.firebase_uid) AS master
         FROM users u
        WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE
        ORDER BY u.firebase_uid`,
      [ENLITE_TENANT_ID],
    );
    const withCell = rows.filter((s) => (s.cells ?? []).includes('talentum:update'));
    const uids = rows.filter((s) => s.master === true || (s.cells ?? []).includes('talentum:update')).map((s) => s.uid);
    return { uids, withCell: withCell.length };
  }
}
