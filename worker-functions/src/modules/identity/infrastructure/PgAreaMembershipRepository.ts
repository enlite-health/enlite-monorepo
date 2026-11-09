/**
 * Escrita do registro de vínculos e leitura dos logins da árvore — só por funções `iam.*` (580/581), nunca por join.
 * Implementa `AreaMembershipWriter` e `LoginDirectory`.
 */
import type { Pool } from 'pg';
import type { AreaMembershipWriter } from '../application/GrantAreaMembershipUseCase';
import type { LoginDirectory } from './areasClaim';
import { identityFromUsers, type UserIdentity } from './identityFromUsers';

export interface LiveMembership {
  id: string;
  personId: string;
  area: string;
  role: string;
  grantedBy: string;
  grantedAt: Date;
}

interface LiveMembershipRow {
  id: string;
  person_id: string;
  area: string;
  role: string;
  granted_by: string;
  granted_at: Date;
}

const toLive = (r: LiveMembershipRow): LiveMembership => ({
  id: r.id,
  personId: r.person_id,
  area: r.area,
  role: r.role,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
});

export class PgAreaMembershipRepository implements AreaMembershipWriter, LoginDirectory {
  constructor(private readonly pool: Pool) {}

  async grant(pid: string, area: string, role: string, actorUid: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT iam.grant_area_membership($1::uuid, $2, $3, $4) AS id`,
      [pid, area, role, actorUid],
    );
    return result.rows[0].id;
  }

  async revoke(pid: string, area: string, role: string, actorUid: string, reason: string): Promise<number> {
    const result = await this.pool.query<{ n: number }>(
      `SELECT iam.revoke_area_membership($1::uuid, $2, $3, $4, $5) AS n`,
      [pid, area, role, actorUid, reason],
    );
    return result.rows[0].n;
  }

  /** Vínculos VIVOS da árvore da pessoa, com id (a rota de staff revoga por id). SELECT é o único privilégio de tabela do runtime (581). */
  async liveByTree(pid: string): Promise<LiveMembership[]> {
    const result = await this.pool.query<LiveMembershipRow>(
      `SELECT id, person_id, area, role, granted_by, granted_at
         FROM iam.area_membership
        WHERE person_id IN (SELECT iam.person_tree($1::uuid)) AND revoked_at IS NULL
        ORDER BY area, role, granted_at`,
      [pid],
    );
    return result.rows.map(toLive);
  }

  /** Um vínculo VIVO pelo id; revogado ou inexistente → `null`. */
  async findLive(id: string): Promise<LiveMembership | null> {
    const result = await this.pool.query<LiveMembershipRow>(
      `SELECT id, person_id, area, role, granted_by, granted_at FROM iam.area_membership WHERE id = $1::uuid AND revoked_at IS NULL`,
      [id],
    );
    return result.rows[0] ? toLive(result.rows[0]) : null;
  }

  async loginUids(pid: string): Promise<string[]> {
    const result = await this.pool.query<{ uid: string }>(`SELECT iam.person_login_uids($1::uuid) AS uid`, [pid]);
    return result.rows.map((r) => r.uid);
  }

  identityFromUsers(uid: string, email?: string): Promise<UserIdentity | null> {
    return identityFromUsers(this.pool, uid, email);
  }
}
