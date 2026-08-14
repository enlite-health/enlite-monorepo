import { Pool, PoolClient, PoolConfig } from 'pg';
import { createRlsAwarePool } from './rlsAwarePool';

/** `DB_POOL_MAX` — o tamanho de hoje do pool principal. */
const DEFAULT_POOL_MAX = 20;
/** `DB_SYSTEM_POOL_MAX` — cron/webhook/público são poucos e curtos. */
const DEFAULT_SYSTEM_POOL_MAX = 5;

/**
 * Tamanho de pool vindo de env, com fallback seguro (valor não-numérico ou ≤0
 * cai no default — dimensionamento errado não pode derrubar o boot). Exportado
 * para os pools fora desta classe (ex.: o RO do MCP) usarem a MESMA regra.
 */
export function poolMax(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Config de sistema PELA METADE não degrada calada.
 *
 * `DB_SYSTEM_USER` sem `DB_SYSTEM_PASSWORD` (ou o contrário) cairia no `else` e
 * o processo subiria com pool ÚNICO — isto é, cron/webhook/rota pública falando
 * como `app_runtime`, sem o atalho de sistema, devolvendo zero linha sob RLS.
 * Um deploy com a env faltando pareceria saudável (health 200) e quebraria só
 * onde ninguém olha. Os dois ausentes seguem sendo configuração válida (pool
 * único, o estado de hoje).
 */
export function assertSystemCredentialsAreComplete(): void {
  const user = process.env.DB_SYSTEM_USER;
  const password = process.env.DB_SYSTEM_PASSWORD;
  if (Boolean(user) === Boolean(password)) return;
  const missing = user ? 'DB_SYSTEM_PASSWORD' : 'DB_SYSTEM_USER';
  throw new Error(
    `[DatabaseConnection] configuração de identidade de sistema incompleta: falta ${missing}. ` +
      'Defina AMBAS (DB_SYSTEM_USER e DB_SYSTEM_PASSWORD) ou NENHUMA — meia configuração faria ' +
      'cron/webhook rodarem como app_runtime, sem o atalho de sistema.',
  );
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
    assertSystemCredentialsAreComplete();
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

  /**
   * @deprecated Use `withActorContext(getPool(), fn)` para escrever.
   *
   * Este método entrega uma conexão do pool CRU de runtime: **fura o roteamento
   * por identidade** (contexto de sistema sairia como `app_runtime`) e **não
   * recebe o contexto de país da request** (sob RLS, zero linha ou escrita sem
   * jurisdição). Também não reusa o client já fixado pela request, então cada
   * chamada consome uma segunda conexão do pool enquanto a request segura a
   * primeira. Continua existindo porque scripts operacionais (`scripts/**`)
   * podem depender dele fora do ciclo de request; em código de produção, não.
   *
   * Mitigação parcial aplicada aqui: a conexão sai pelo pool CIENTE do contexto
   * (`rlsAwarePool.connect()`), então ao menos a IDENTIDADE está certa — o que
   * segue faltando é o `SET` de país, que só `withActorContext` faz. Com a flag
   * desligada isto é byte por byte o comportamento anterior.
   */
  public async getClient(): Promise<PoolClient> {
    if (process.env.COUNTRY_RLS_ENABLED === 'true') {
      console.warn(
        '[DatabaseConnection] getClient() chamado com COUNTRY_RLS_ENABLED=true — conexão SEM contexto de país aplicado. Use withActorContext(getPool(), fn).',
      );
    }
    return await this.rlsAwarePool.connect();
  }

  public async close(): Promise<void> {
    await this.pool.end();
    if (this.systemPool !== this.pool) {
      await this.systemPool.end();
    }
  }
}
