/**
 * src/modules/identity/permissions/infrastructure/PgPermissionAuditRepository.ts
 *
 * Trilha de DECISÃO (`iam.permission_audit_log`, mig 280): DENY sempre; ALLOW só
 * no que a D-P4 lista (PII, paciente, documento, delete/execute/export).
 *
 * Duas assimetrias deliberadas, herdadas do molde do `resource_access_log` (270):
 *
 *  · ESCRITA é síncrona-solta e FAIL-SAFE — `record()` não devolve promessa e
 *    engole o erro em log. Auditoria não pode derrubar atendimento; uma trilha
 *    que quebra a request troca um registro perdido por um incidente.
 *  · LEITURA é gated no banco (`iam.query_audit`, lex C7): a role do app NÃO tem
 *    SELECT na tabela, a função exige `permission_management:read` e registra o
 *    próprio ato de auditar. Por isso a leitura roda numa transação com o ator
 *    carimbado — sem GUC de ator, a função recusa.
 *
 * (lex C16) Nada de PII: só uid do staff, célula e id do alvo.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import type {
  PermissionAuditFilters,
  PermissionAuditRepository,
  PermissionAuditRow,
  PermissionDecision,
} from '../application/ports';
import { readRows, withStaffWrite } from './dbAccess';

const INSERT_SQL = `
  INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision, country, simulation_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export class PgPermissionAuditRepository implements PermissionAuditRepository {
  constructor(private readonly pool: Pool) {}

  record(entry: PermissionDecision): void {
    void this.pool
      .query(INSERT_SQL, [
        entry.tenantId,
        entry.userId,
        entry.resource,
        entry.action,
        entry.resourceId ?? null,
        entry.decision,
        entry.country ?? null,
        entry.simulationId ?? null,
      ])
      .catch((err: unknown) => {
        logger.error(
          {
            err,
            uid: entry.userId,
            cell: `${entry.resource}:${entry.action}`,
            decision: entry.decision,
          },
          '[perm] falha ao gravar permission_audit_log — decisão NÃO registrada',
        );
      });
  }

  async query(filters: PermissionAuditFilters): Promise<PermissionAuditRow[]> {
    // Transação (não `pool.query` solto) porque a função escreve a linha do
    // próprio ato e precisa do ator no GUC — `withStaffWrite` põe os dois.
    return withStaffWrite(this.pool, async (client) => {
      const result = await readRows(() =>
        client.query<{
          id: string;
          user_id: string;
          resource: string;
          action: string;
          resource_id: string | null;
          decision: string;
          created_at: Date;
          country: string | null;
        }>(`SELECT * FROM iam.query_audit($1, $2, $3, $4, $5)`, [
          filters.userId ?? null,
          filters.resource ?? null,
          filters.since ?? null,
          filters.until ?? null,
          filters.limit ?? null,
        ]),
      );
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        resource: row.resource,
        action: row.action,
        resourceId: row.resource_id,
        decision: row.decision,
        createdAt: row.created_at,
        country: row.country,
      }));
    });
  }
}
