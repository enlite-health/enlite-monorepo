/**
 * Leitura do registro de áreas por `pid` — só por funções `iam.*` (580/581), nunca por join em `iam.*`.
 * `backoffice`·staff NÃO é lido aqui: vem do principal do login (V1), no use case.
 */
import type { Pool } from 'pg';
import type { AreaRegistryReader, StoredMembership } from '../application/ListPersonAreasUseCase';

export class PgAreaRegistryRepository implements AreaRegistryReader {
  constructor(private readonly pool: Pool) {}

  async hasWorkerInTree(pid: string): Promise<boolean> {
    const result = await this.pool.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM workers w WHERE w.auth_uid IN (SELECT iam.person_login_uids($1::uuid))
       ) AS found`,
      [pid],
    );
    return result.rows[0]?.found === true;
  }

  async storedMemberships(pid: string): Promise<StoredMembership[]> {
    const result = await this.pool.query<StoredMembership>(
      `SELECT area, role FROM iam.effective_area_memberships($1::uuid)`,
      [pid],
    );
    return result.rows.map((r) => ({ area: r.area, role: r.role }));
  }
}
