/**
 * SubstitutionRequestWriter — o CABEÇALHO do pedido de substituição (migration 548, spec 069). UMA query por método no
 * `client` recebido; a transação é de quem chama. `country` não é passado (o gatilho herda do serviço). Sem texto livre:
 * pessoa por id, motivo por `code` do catálogo. Tipo, período, nº de turnos e "quem entra" NÃO são gravados (derivados).
 * O banco recusa motivo/pessoa divergentes no registro de trocas (FK composta) e ausência fora do pedido (trigger 4).
 */
import type { PoolClient } from 'pg';

export interface InsertSubstitutionRequestInput {
  serviceId: string;
  outgoingWorkerId: string;
  reasonCode: string;
  actorUid: string;
}

export class SubstitutionRequestWriter {
  async insert(client: PoolClient, input: InsertSubstitutionRequestInput): Promise<{ id: string }> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO patient_itinerary_substitution_request (contracted_service_id, outgoing_worker_id, reason_code, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.serviceId, input.outgoingWorkerId, input.reasonCode, input.actorUid],
    );
    return { id: res.rows[0].id };
  }

  /** Marca o pedido como desfeito (o único dono de "desfeito"). `0` = já estava desfeito. O banco recusa se ainda houver ausência viva de hoje em diante (23514). */
  async markUndone(client: PoolClient, id: string, actorUid: string): Promise<number> {
    const res = await client.query(
      `UPDATE patient_itinerary_substitution_request SET undone_at = now(), undone_by = $2 WHERE id = $1 AND undone_at IS NULL`,
      [id, actorUid],
    );
    return res.rowCount ?? 0;
  }
}
