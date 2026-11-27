import { createHash } from 'crypto';
import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import type { Pool } from 'pg';
import { DatabaseConnection } from '../database/DatabaseConnection';

/**
 * Store do `express-rate-limit` sobre Postgres: o contador é compartilhado entre instâncias (o MemoryStore conta por
 * instância e o teto efetivo vira N×). Um store por limitador (`prefix` distinto: o express-rate-limit recusa a mesma
 * instância em dois limitadores). A chave gravada é `prefix + ':' + sha256(key)` — uid/IP nunca vai cru ao banco.
 * Janela FIXA por chave, como o MemoryStore. Erro do banco sobe (falha fechada; `passOnStoreError` fica `false`).
 */
export class PgRateLimitStore implements Store {
  private windowSecs = 900;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    readonly prefix: string,
  ) {}

  init(options: Options): void {
    this.windowSecs = options.windowMs / 1000;
  }

  private dbKey(key: string): string {
    return `${this.prefix}:${createHash('sha256').update(key).digest('hex')}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const { rows } = await this.pool.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limit_counters (key, hits, reset_at) VALUES ($1, 1, NOW() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         hits     = CASE WHEN rate_limit_counters.reset_at <= NOW() THEN 1 ELSE rate_limit_counters.hits + 1 END,
         reset_at = CASE WHEN rate_limit_counters.reset_at <= NOW() THEN NOW() + make_interval(secs => $2) ELSE rate_limit_counters.reset_at END
       RETURNING hits, reset_at`,
      [this.dbKey(key), this.windowSecs],
    );
    return { totalHits: rows[0].hits, resetTime: rows[0].reset_at };
  }

  async decrement(key: string): Promise<void> {
    await this.pool.query('UPDATE rate_limit_counters SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [this.dbKey(key)]);
  }

  async resetKey(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [this.dbKey(key)]);
  }
}

export function createPgRateLimitStore(prefix: string): PgRateLimitStore {
  // Pool resolvido na consulta, não na criação: as rotas criam o store no carregamento do módulo (sem DB configurado em teste).
  const lazyPool: Pick<Pool, 'query'> = {
    query: ((...args: unknown[]) =>
      (DatabaseConnection.getInstance().getPool().query as (...a: unknown[]) => unknown)(...args)) as Pool['query'],
  };
  return new PgRateLimitStore(lazyPool, prefix);
}
