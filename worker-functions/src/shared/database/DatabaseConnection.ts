import { Pool, PoolClient, PoolConfig } from 'pg';
import { createRlsAwarePool } from './rlsAwarePool';

/** `DB_POOL_MAX` — o tamanho de hoje do pool principal. */
const DEFAULT_POOL_MAX = 20;
/** `DB_SYSTEM_POOL_MAX` — cron/webhook/público são poucos e curtos. */
const DEFAULT_SYSTEM_POOL_MAX = 5;

function poolMax(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * UM PROCESSO, DUAS IDENTIDADES DE BANCO (ABAC país, task 3.2).
 *
 * A RLS de país tem dois lados: `app_runtime` (staff, confinada ao país da
 * request) e `app_system` (cron/webhook/rota pública — o atalho de sistema, que
 * a policy só concede a quem é MEMBRO de `app_system` E declara
 * `app.system_context`). Como o mesmo processo atende os dois, ele precisa de
 * duas conexões com identidades diferentes.
 *
 * Por que dois POOLS e não `SET ROLE` num login único membro das duas roles:
 * `SET ROLE` é reversível por SQL. Um login membro de `app_system` que rodasse
 * staff sob `SET ROLE app_runtime` transformaria qualquer SQL injection em
 * escalada de privilégio (`RESET ROLE`), e o core do node-postgres não oferece
 * mitigação para isso (o padrão de pool-por-identidade é o mesmo de
 * brianc/node-postgres#1659). Dois pools deixam a fronteira no servidor: o
 * usuário `enlite_runtime` simplesmente NÃO é membro de `app_system`.
 *
 * Sem `DB_SYSTEM_USER`/`DATABASE_SYSTEM_URL` configurados, o pool de sistema É o
 * pool principal — dev, teste e a produção de hoje seguem com um pool só, byte
 * por byte o comportamento anterior.
 */
export class DatabaseConnection {
  private static instance: DatabaseConnection;
  private pool: Pool;
  /**
   * Pool com a identidade de sistema. Igual a `pool` quando as envs de sistema
   * não estão configuradas (o caso de hoje).
   */
  private systemPool: Pool;
  /**
   * O que os 115 consumidores recebem: o mesmo pool, ciente do contexto de país
   * da request (ver `rlsAwarePool.ts`). Com `COUNTRY_RLS_ENABLED` != 'true' é
   * passagem direta — comportamento idêntico ao de antes da change.
   */
  private rlsAwarePool: Pool;

  private constructor() {
    const isCloudRun = process.env.K_SERVICE !== undefined;
    const max = poolMax('DB_POOL_MAX', DEFAULT_POOL_MAX);
    // Dimensionamento: o stg (db-f1-micro) tem ~25 `max_connections` no total —
    // 20+5 já encosta no teto com UMA instância. O número final sai da medição
    // da task 4.1 (staging), por isso os dois são configuráveis por env.
    const systemMax = poolMax('DB_SYSTEM_POOL_MAX', DEFAULT_SYSTEM_POOL_MAX);

    if (isCloudRun && process.env.DB_HOST?.startsWith('/cloudsql/')) {
      // Cloud SQL via Unix socket (Cloud Run)
      const socketConfig: PoolConfig = {
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        max,
        idleTimeoutMillis: 10000,       // fecha idle antes do Cloud SQL proxy encerrar
        connectionTimeoutMillis: 10000, // cold start do Cloud Run pode demorar mais de 2s
      };
      this.pool = new Pool({
        ...socketConfig,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      });
      this.systemPool =
        process.env.DB_SYSTEM_USER && process.env.DB_SYSTEM_PASSWORD
          ? new Pool({
              ...socketConfig,
              user: process.env.DB_SYSTEM_USER,
              password: process.env.DB_SYSTEM_PASSWORD,
              max: systemMax,
            })
          : this.pool;
    } else if (process.env.DATABASE_URL) {
      // Local development via connection string
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      this.systemPool = process.env.DATABASE_SYSTEM_URL
        ? new Pool({
            connectionString: process.env.DATABASE_SYSTEM_URL,
            max: systemMax,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
          })
        : this.pool;
    } else {
      throw new Error('No database configuration found. Set either DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD');
    }

    // Não crashar o processo em erros de idle client — pg-pool reconecta automaticamente.
    // process.exit() aqui derruba o servidor inteiro toda vez que o Cloud SQL proxy
    // encerra uma conexão idle, causando 500 nas requisições seguintes.
    this.pool.on('error', (err) => {
      console.error('[DatabaseConnection] Idle client error (non-fatal):', err.message);
    });
    if (this.systemPool !== this.pool) {
      this.systemPool.on('error', (err) => {
        console.error('[DatabaseConnection] Idle client error on system pool (non-fatal):', err.message);
      });
    }

    this.rlsAwarePool = createRlsAwarePool(this.pool, this.systemPool);
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

  /**
   * Pool CRU com a identidade de SISTEMA. Idêntico a `getRawPool()` quando as
   * envs de sistema não estão configuradas. Também só para infra — quem quer o
   * atalho de sistema no código de negócio usa `withSystemDbContext`, que faz o
   * roteamento sozinho.
   */
  public getSystemPool(): Pool {
    return this.systemPool;
  }

  public async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  public async close(): Promise<void> {
    await this.pool.end();
    if (this.systemPool !== this.pool) {
      await this.systemPool.end();
    }
  }
}
