/**
 * Escrita do registro de vínculos e leitura dos logins da árvore — só por funções `iam.*` (580/581), nunca por join.
 * Implementa `AreaMembershipWriter` e `LoginDirectory`.
 */
import type { Pool } from 'pg';
import type { AreaMembershipWriter } from '../application/GrantAreaMembershipUseCase';
import type { LoginDirectory } from './areasClaim';
import { identityFromUsers, type UserIdentity } from './identityFromUsers';

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

  async loginUids(pid: string): Promise<string[]> {
    const result = await this.pool.query<{ uid: string }>(`SELECT iam.person_login_uids($1::uuid) AS uid`, [pid]);
    return result.rows.map((r) => r.uid);
  }

  identityFromUsers(uid: string, email?: string): Promise<UserIdentity | null> {
    return identityFromUsers(this.pool, uid, email);
  }
}
