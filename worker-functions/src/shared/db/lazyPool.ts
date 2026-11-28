import type { Pool } from 'pg';
import { DatabaseConnection } from '../database/DatabaseConnection';

/**
 * Pool que só é resolvido na consulta, não na criação. Quem monta objetos no carregamento do módulo ou no boot (store do
 * rate limit, ledger do OTP) não pode chamar `getPool()` ali: sem banco configurado (jest) `getInstance()` lança, e no boot
 * seria comportamento novo. O método é chamado NO pool (`this` preservado).
 */
export function lazyPool(): Pick<Pool, 'query'> {
  return {
    query: ((...args: Parameters<Pool['query']>) => {
      const pool = DatabaseConnection.getInstance().getPool();
      return (pool.query as (...a: unknown[]) => unknown).apply(pool, args);
    }) as Pool['query'],
  };
}
