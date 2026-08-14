/**
 * Fábrica de pools (ABAC país, task 3.2 + review).
 *
 * O que estes testes travam:
 *  - a configuração de HOJE (sem envs de sistema) segue com pool ÚNICO — o pool
 *    de sistema É o principal, byte por byte o comportamento anterior;
 *  - com `DATABASE_SYSTEM_URL`/`DB_SYSTEM_USER` nascem DOIS pools, cada um com
 *    seu handler de erro de client idle (sem ele, um `error` sem listener mata o
 *    processo quando o Cloud SQL derruba conexão ociosa);
 *  - config de sistema PELA METADE explode no boot em vez de degradar calada
 *    para pool único (cron falando como app_runtime é zero linha sob RLS);
 *  - `DB_POOL_MAX` inválido cai no default em vez de virar `NaN` no pg.
 *
 * O módulo `pg` é mockado: nenhuma conexão real é aberta. Cada caso roda em
 * `jest.isolateModules` porque `DatabaseConnection` guarda instância estática.
 */

interface FakePoolConfig {
  connectionString?: string;
  user?: string;
  password?: string;
  host?: string;
  max?: number;
}

const createdPools: FakePool[] = [];

class FakePool {
  public readonly on = jest.fn();
  public readonly connect = jest.fn();
  public readonly query = jest.fn();
  public readonly end = jest.fn();
  constructor(public readonly config: FakePoolConfig) {
    createdPools.push(this);
  }
}

jest.mock('pg', () => ({ Pool: jest.fn((config: FakePoolConfig) => new FakePool(config)) }));

const DB_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_SYSTEM_URL',
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_SYSTEM_USER',
  'DB_SYSTEM_PASSWORD',
  'DB_POOL_MAX',
  'DB_SYSTEM_POOL_MAX',
  'K_SERVICE',
] as const;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  createdPools.length = 0;
  for (const key of DB_ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Constrói a conexão num registro de módulos limpo (instância estática). */
function build(): {
  pool: FakePool;
  systemPool: FakePool;
  appPool: import('pg').Pool;
} {
  let result!: { pool: FakePool; systemPool: FakePool; appPool: import('pg').Pool };
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
    const instance = DatabaseConnection.getInstance();
    result = {
      pool: instance.getRawPool() as unknown as FakePool,
      systemPool: instance.getSystemPool() as unknown as FakePool,
      appPool: instance.getPool(),
    };
  });
  return result;
}

function buildExpectingThrow(): () => void {
  return () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
      DatabaseConnection.getInstance();
    });
  };
}

describe('DatabaseConnection — fábrica de pools', () => {
  it('sem envs de sistema: UM pool só (o de sistema É o principal)', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';

    const { pool, systemPool } = build();

    expect(createdPools).toHaveLength(1);
    expect(systemPool).toBe(pool);
    expect(pool.config.max).toBe(20);
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('com DATABASE_SYSTEM_URL: dois pools, cada um com handler de erro idle', () => {
    process.env.DATABASE_URL = 'postgres://runtime@localhost/enlite';
    process.env.DATABASE_SYSTEM_URL = 'postgres://system@localhost/enlite';
    process.env.DB_SYSTEM_POOL_MAX = '4';

    const { pool, systemPool } = build();

    expect(createdPools).toHaveLength(2);
    expect(systemPool).not.toBe(pool);
    expect(systemPool.config.connectionString).toBe('postgres://system@localhost/enlite');
    expect(systemPool.config.max).toBe(4);
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(systemPool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('o handler de erro idle NÃO derruba o processo (só loga)', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    const { pool } = build();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = pool.on.mock.calls.find((c) => c[0] === 'error')![1] as (e: Error) => void;
    expect(() => handler(new Error('conexão idle caiu'))).not.toThrow();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('o pool de SISTEMA também sobrevive a erro de client idle', () => {
    process.env.DATABASE_URL = 'postgres://runtime@localhost/enlite';
    process.env.DATABASE_SYSTEM_URL = 'postgres://system@localhost/enlite';
    const { systemPool } = build();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = systemPool.on.mock.calls.find((c) => c[0] === 'error')![1] as (e: Error) => void;
    expect(() => handler(new Error('idle do pool de sistema'))).not.toThrow();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('system pool'), 'idle do pool de sistema');
    spy.mockRestore();
  });

  it('Cloud Run (socket) com identidade de sistema: dois pools no mesmo socket', () => {
    process.env.K_SERVICE = 'worker-functions';
    process.env.DB_HOST = '/cloudsql/enlite-prd:southamerica-west1:enlite-ar-db';
    process.env.DB_NAME = 'enlite';
    process.env.DB_USER = 'enlite_runtime';
    process.env.DB_PASSWORD = 'x';
    process.env.DB_SYSTEM_USER = 'enlite_system';
    process.env.DB_SYSTEM_PASSWORD = 'y';

    const { pool, systemPool } = build();

    expect(pool.config.user).toBe('enlite_runtime');
    expect(systemPool.config.user).toBe('enlite_system');
    expect(systemPool.config.host).toBe(process.env.DB_HOST);
    expect(systemPool.config.max).toBe(5);
  });

  it('Cloud Run (socket) SEM identidade de sistema: segue com pool único', () => {
    process.env.K_SERVICE = 'worker-functions';
    process.env.DB_HOST = '/cloudsql/enlite-prd:southamerica-west1:enlite-ar-db';
    process.env.DB_NAME = 'enlite';
    process.env.DB_USER = 'enlite_app';
    process.env.DB_PASSWORD = 'x';

    const { pool, systemPool } = build();

    expect(createdPools).toHaveLength(1);
    expect(systemPool).toBe(pool);
  });

  it('config de sistema PELA METADE explode no boot (não degrada para pool único)', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    process.env.DB_SYSTEM_USER = 'enlite_system';

    expect(buildExpectingThrow()).toThrow(/DB_SYSTEM_PASSWORD/);

    process.env.DB_SYSTEM_PASSWORD = 'y';
    delete process.env.DB_SYSTEM_USER;
    expect(buildExpectingThrow()).toThrow(/DB_SYSTEM_USER/);
  });

  it('DB_POOL_MAX inválido cai no default (nunca NaN no pg)', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    process.env.DB_POOL_MAX = 'muitos';

    expect(build().pool.config.max).toBe(20);

    createdPools.length = 0;
    process.env.DB_POOL_MAX = '0';
    expect(build().pool.config.max).toBe(20);

    createdPools.length = 0;
    process.env.DB_POOL_MAX = '35';
    expect(build().pool.config.max).toBe(35);
  });

  it('sem configuração nenhuma de banco, recusa construir', () => {
    expect(buildExpectingThrow()).toThrow(/No database configuration found/);
  });

  it('getPool() entrega o pool CIENTE do contexto; getRawPool(), o cru', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    const { pool, appPool } = build();

    expect(appPool).not.toBe(pool);
    // O proxy preserva o alvo: propriedade lida sai do pool real.
    expect((appPool as unknown as FakePool).config.connectionString).toBe(
      'postgres://app@localhost/enlite',
    );
  });

  it('getClient() roteia pelo pool ciente do contexto e avisa sob a flag', async () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    let client: unknown;
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
      const instance = DatabaseConnection.getInstance();
      (instance.getRawPool() as unknown as FakePool).connect.mockResolvedValue({ id: 'c1' });
      client = await instance.getClient();
    });

    expect(client).toEqual({ id: 'c1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('getClient()'));
    warn.mockRestore();
    delete process.env.COUNTRY_RLS_ENABLED;
  });

  it('close() encerra os DOIS pools quando são distintos', async () => {
    process.env.DATABASE_URL = 'postgres://runtime@localhost/enlite';
    process.env.DATABASE_SYSTEM_URL = 'postgres://system@localhost/enlite';

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
      const instance = DatabaseConnection.getInstance();
      await instance.close();
      expect((instance.getRawPool() as unknown as FakePool).end).toHaveBeenCalledTimes(1);
      expect((instance.getSystemPool() as unknown as FakePool).end).toHaveBeenCalledTimes(1);
    });
  });

  it('close() com pool único encerra uma vez só', async () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
      const instance = DatabaseConnection.getInstance();
      await instance.close();
      expect((instance.getRawPool() as unknown as FakePool).end).toHaveBeenCalledTimes(1);
    });
  });

  it('getInstance() é singleton', () => {
    process.env.DATABASE_URL = 'postgres://app@localhost/enlite';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('../DatabaseConnection') as typeof import('../DatabaseConnection');
      expect(DatabaseConnection.getInstance()).toBe(DatabaseConnection.getInstance());
      expect(createdPools).toHaveLength(1);
    });
  });
});
