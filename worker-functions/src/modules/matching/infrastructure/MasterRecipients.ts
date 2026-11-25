import type { Pool, PoolClient } from 'pg';

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * Membros VIVOS do Acesso Master (change tactiq-vinculo-resiliente, D12): staff `ACTIVE` e `is_active` e filiação viva ao grupo de id fixo,
 * resolvida por `iam.is_master_member` (migration 458) — a MESMA consulta de `UncoveredAlertRecipients` (spec 069) e `DecisoresPedidosIa`
 * (spec 078). Só LÊ: grupo e filiação são da operação, nunca criados nem alterados aqui. Devolve só uids (sem e-mail, sem nome).
 * Unificar as 3 cópias da consulta é LISTA (design, "fora de escopo").
 */
export async function activeMasterUids(ex: Db): Promise<string[]> {
  const { rows } = await ex.query<{ uid: string }>(
    `SELECT u.firebase_uid AS uid
       FROM users u
      WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE AND iam.is_master_member(u.firebase_uid)
      ORDER BY u.firebase_uid`,
  );
  return rows.map((r) => r.uid);
}
