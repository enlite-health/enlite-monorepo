import { Pool, PoolClient } from 'pg';
import { createRlsAwarePool } from './rlsAwarePool';

export class DatabaseConnection {
  private static instance: DatabaseConnection;
  private pool: Pool;
  /**
   * O que os 115 consumidores recebem: o mesmo pool, ciente do contexto de país
   * da request (ver `rlsAwarePool.ts`). Com `COUNTRY_RLS_ENABLED` != 'true' é
   * passagem direta — comportamento idêntico ao de antes da change.
   */
  private rlsAwarePool: Pool;

  private constructor() {
    const isCloudRun = process.env.K_SERVICE !== undefined;
    
    if (isCloudRun && process.env.DB_HOST?.startsWith('/cloudsql/')) {
      // Cloud SQL via Unix socket (Cloud Run)
      this.pool = new Pool({
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 20,
        idleTimeoutMillis: 10000,       // fecha idle antes do Cloud SQL proxy encerrar
        connectionTimeoutMillis: 10000, // cold start do Cloud Run pode demorar mais de 2s
      });
    } else if (process.env.DATABASE_URL) {
      // Local development via connection string
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    } else {
      throw new Error('No database configuration found. Set either DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD');
    }

    // Não crashar o processo em erros de idle client — pg-pool reconecta automaticamente.
    // process.exit() aqui derruba o servidor inteiro toda vez que o Cloud SQL proxy
    // encerra uma conexão idle, causando 500 nas requisições seguintes.
    this.pool.on('error', (err) => {
      console.error('[DatabaseConnection] Idle client error (non-fatal):', err.message);
    });

    this.rlsAwarePool = createRlsAwarePool(this.pool);
  }

  public static getInstance(): DatabaseConnection {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection();
    }
    return DatabaseConnection.instance;
  }

  public getPool(): Pool {
    return this.rlsAwarePool;
  }

  /**
   * Pool CRU, sem o roteamento por contexto de request. Só para quem gerencia a
   * conexão em si (encerramento, health check de infra) — código de negócio usa
   * `getPool()`, senão a leitura escapa da RLS de país.
   */
  public getRawPool(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
