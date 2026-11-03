import type { Pool } from 'pg';
import { withSystemDbContext } from '@shared/database/requestDbSession';

export interface AgentUserRow {
  uid: string;
  accountType: string;
  status: string;
}

/** Porta: e-mail da SA -> linhas de `users`. Sem cache, por desenho (o pânico é `users.status`, lido a CADA request). */
export interface AgentUserRepository {
  findByEmail(email: string): Promise<AgentUserRow[]>;
}

/**
 * Leitura de `users` por e-mail, a cada chamada. Roda sob contexto de SISTEMA declarado só para ESTA consulta
 * (`agent-auth-lookup`): antes de haver ator, a RLS de `users` não tem de quem ser; nunca executa capability.
 * `LIMIT 2`: mais de uma linha para o mesmo e-mail é ambiguidade e o middleware recusa (fail-closed).
 */
export class PgAgentUserRepository implements AgentUserRepository {
  constructor(private readonly pool: Pool) {}

  findByEmail(email: string): Promise<AgentUserRow[]> {
    return withSystemDbContext('agent-auth-lookup', async () => {
      const r = await this.pool.query<{ firebase_uid: string; account_type: string; status: string }>(
        `SELECT firebase_uid, account_type, status FROM users WHERE email = $1 LIMIT 2`,
        [email],
      );
      return r.rows.map((x) => ({ uid: x.firebase_uid, accountType: x.account_type, status: x.status }));
    });
  }
}
