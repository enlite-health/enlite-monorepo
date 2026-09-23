/**
 * src/modules/identity/permissions/infrastructure/PgGroupSimulationRepository.ts
 *
 * Spec 026 (D407) — a simulação em si, nunca `iam.user_groups` (a simulação não
 * é filiação). Leitura (`findActive`) chama `iam.active_group_simulation`
 * direto, como `PgEffectiveAuthzRepository` chama `iam.effective_permissions`
 * (mesma função que decide a request, nunca SQL próprio). Escrita
 * (`start`/`end`) é EXCLUSIVA das funções `SECURITY DEFINER` da migration 458
 * — a role do app não tem INSERT/UPDATE em `iam.group_simulations` (a
 * migration revoga explicitamente).
 *
 * ⚠️ `uid`/`tenantId` NÃO viram parâmetro SQL em `start`/`end`: as writer
 * functions (`iam.start_group_simulation(p_group_id, p_ttl)`,
 * `iam.end_group_simulation()`) derivam o ATOR de `iam._actor()`
 * (`current_setting('app.user_uid')`) e o TENANT de `iam.current_tenant_id()`
 * — GUCs que `withStaffWrite` (`dbAccess.ts:26`) já carimba a partir do
 * contexto da request, o MESMO molde de `PgPermissionGroupRepository` (nenhum
 * método de escrita de lá recebe uid explícito). Ficam na assinatura da porta
 * (`ports.ts`) por simetria com `findActive` — que É um parâmetro real da SQL
 * — e porque o USE CASE precisa do `uid` para `PermissionEventPublisher.
 * permissionChanged([uid])` depois (T2.4).
 */

import type { Pool } from 'pg';
import type { GroupSimulationRepository } from '../application/ports';
import type { GroupSimulation } from '../domain/GroupSimulation';
import { PermissionError } from '../domain/PermissionError';
import { readRows, withStaffWrite } from './dbAccess';

interface SimulationRow {
  id: string;
  group_id: string;
  group_name: string;
  started_at: Date;
  expires_at: Date;
}

function toSimulation(row: SimulationRow): GroupSimulation {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  };
}

/** `s.*` decompõe o composto que a função devolve (molde do `SNAPSHOT_SQL` para `active_group_simulation`). */
const ACTIVE_SQL = `
  SELECT s.id, s.group_id, g.name AS group_name, s.started_at, s.expires_at
    FROM iam.active_group_simulation($1, $2) s
    JOIN iam.permission_groups g ON g.id = s.group_id`;

const START_SQL = `
  SELECT s.id, s.group_id, g.name AS group_name, s.started_at, s.expires_at
    FROM iam.start_group_simulation($1, $2::interval) s
    JOIN iam.permission_groups g ON g.id = s.group_id`;

const END_SQL = `SELECT iam.end_group_simulation() AS ended`;

export class PgGroupSimulationRepository implements GroupSimulationRepository {
  constructor(private readonly pool: Pool) {}

  async findActive(uid: string, tenantId: string): Promise<GroupSimulation | null> {
    const result = await readRows(() => this.pool.query<SimulationRow>(ACTIVE_SQL, [uid, tenantId]));
    const row = result.rows[0];
    return row ? toSimulation(row) : null;
  }

  async start(_uid: string, _tenantId: string, groupId: string, ttl: string): Promise<GroupSimulation> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<SimulationRow>(START_SQL, [groupId, ttl]);
      const row = result.rows[0];
      // Alcançável só se a função devolver sem lançar E sem linha — não deveria
      // acontecer (`start_group_simulation` sempre insere ou lança); fail-closed
      // em vez de devolver um `GroupSimulation` inventado (molde `PgPermissionGroupRepository.create`).
      if (!row) throw new PermissionError('invalid_input', 'Simulação não foi criada');
      return toSimulation(row);
    });
  }

  async end(_uid: string, _tenantId: string): Promise<boolean> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ ended: boolean }>(END_SQL);
      return result.rows[0]?.ended ?? false;
    });
  }
}
