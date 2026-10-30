import type { PoolClient } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';

/**
 * Quem decide pedidos do Sol: staff ATIVO com a célula `pedidos_ia:decidir` OU membro vivo do Acesso Master. Mesma regra e mesma
 * consulta do `UncoveredAlertRecipients` (069): quem não pode agir não recebe. Nenhum grupo é criado nem alterado — quem recebe é
 * decisão da operação, ao conceder a célula. Roda no `client` da transação do depósito.
 */
export async function resolverDecisoresPedidosIa(c: PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ uid: string; cells: string[] | null; master: boolean | null }>(
    `SELECT u.firebase_uid AS uid,
            iam.effective_permissions(u.firebase_uid, $1::uuid) AS cells,
            iam.is_master_member(u.firebase_uid) AS master
       FROM users u
      WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE
      ORDER BY u.firebase_uid`,
    [ENLITE_TENANT_ID],
  );
  return rows.filter((s) => (s.cells ?? []).includes('pedidos_ia:decidir') || s.master === true).map((s) => s.uid);
}
