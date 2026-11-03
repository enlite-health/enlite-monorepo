import type { PoolClient } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { logger } from '@shared/logging';

/**
 * Quem decide pedidos do Sol: staff ATIVO com a célula `pedidos_ia:decidir` (resolução real pelo IAM). O Acesso Master NÃO decide
 * mais; só entra como RESERVA quando ninguém tem a célula (grupo ainda não criado pela operação), com 1 `warn` sem PII. Nenhum
 * grupo é criado nem alterado. Roda no `client` da transação do depósito.
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
  const decisores = rows.filter((s) => (s.cells ?? []).includes('pedidos_ia:decidir')).map((s) => s.uid);
  if (decisores.length > 0) return decisores;
  logger.warn('[agentes] sem decisor com pedidos_ia:decidir; aviso ao Acesso Master');
  return rows.filter((s) => s.master === true).map((s) => s.uid);
}
