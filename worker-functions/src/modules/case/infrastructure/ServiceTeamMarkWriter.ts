/**
 * ServiceTeamMarkWriter — quadro C (Servicio Contratado), Fase 10, DX-10.6 (2).
 *
 * A ÚNICA escrita de `contracted_service_rejections` (migration 481): `insertRejection` grava a
 * marca (rejeitar de novo cria linha NOVA — a categoria de uma marca já existente nunca é
 * reescrita); `revertRejection` grava `reverted_*` na MESMA linha ativa (nunca `DELETE` — a
 * tabela É o log). Nenhuma outra tabela do funil de candidatura ou do itinerário é tocada por
 * este arquivo (invariante 6) — quem checa a elegibilidade (candidato/alocado) é
 * `deriveServiceTeam`, antes de chamar este escritor.
 *
 * Cada método faz UMA query, no `client` recebido (a transação é de quem chama —
 * `ServiceTeamMarkUseCase`, dentro de `inPatientTransaction`).
 */
import type { PoolClient } from 'pg';

export interface InsertRejectionInput {
  serviceId: string;
  workerId: string;
  category: string;
  actorUid: string;
}

export interface RevertRejectionInput {
  serviceId: string;
  workerId: string;
  category: string;
  actorUid: string;
}

export class ServiceTeamMarkWriter {
  /** Linha nova sempre — a corrida (2 rejeições ativas do mesmo par) é o índice `uq_csr_active_pair` (23505). */
  async insertRejection(client: PoolClient, input: InsertRejectionInput): Promise<void> {
    await client.query(
      `INSERT INTO contracted_service_rejections
         (service_id, worker_id, reject_reason_category, rejected_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [input.serviceId, input.workerId, input.category, input.actorUid],
    );
  }

  /** `rowCount` = 0 quando não havia marca ativa (já revertida, ou nunca existiu) — quem chama decide o que fazer. */
  async revertRejection(client: PoolClient, input: RevertRejectionInput): Promise<number> {
    const res = await client.query(
      `UPDATE contracted_service_rejections
          SET reverted_at = now(), reverted_by = $3, revert_reason_category = $4,
              updated_by = $3, updated_at = now()
        WHERE service_id = $1 AND worker_id = $2 AND reverted_at IS NULL`,
      [input.serviceId, input.workerId, input.actorUid, input.category],
    );
    return res.rowCount ?? 0;
  }
}
