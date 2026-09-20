/**
 * migration454.repo.test.ts — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a
 * migration 454 (spec 021, Bloco 2b, T254).
 *
 * Decisão do Gabriel (20/09/2026), retomando a D124 (19/08 — "assinar ou apagar" o Financeiro e
 * o Super Admin) e a migration 432 (que já tirou `is_system` de Recrutador/Community
 * Manager/Financeiro mas deixou o Super Admin de fora): **o ÚNICO grupo `is_system` deve ser o
 * Acesso Master.** Qualquer outro grupo (Super Admin incluso) será arquivado pela tela — o que
 * `iam.archive_group` (migration 279) só permite quando `is_system = false`.
 *
 * Este teste mede ESTADO, não a existência do arquivo de migration: conta quantos grupos vivos
 * têm `is_system = true` depois de toda a cadeia de migrations (206 → 454) ser aplicada num banco
 * efêmero próprio, do zero. MORRE se a decisão for desfeita — qualquer grupo diferente do Acesso
 * Master (`a0000000-0000-0000-0000-000000000001`) voltando a `is_system = true` (revert manual da
 * 454, remoção da migration, ou migration nova que reintroduza a flag em outro grupo) falha a
 * asserção abaixo.
 *
 * SELF-CONTAINED (mesmo protocolo do `migration434.repo.test.ts`): cria um banco EFÊMERO próprio
 * (`CREATE DATABASE`, nome único por execução) na mesma instância do `DATABASE_URL`, aplica TODAS
 * as migrations do diretório em ordem numérica (mesma regra de `run-migrations-docker.js`) e
 * derruba o banco no `afterAll`. Não depende de nenhum estado prévio de `DATABASE_URL`.
 *
 * Como rodar (basta UM Postgres de pé):
 *   docker run -d --name pg454test -p 127.0.0.1:5455:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5455/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand migration454
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const BASE_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5455/enlite_e2e';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

const ACESSO_MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const SUPER_ADMIN_ID = 'a0000000-0000-0000-0000-000000000005';

/** Mesma regra de ordenação de `scripts/run-migrations-docker.js` (prefixo numérico, empate por nome CRU). */
function sortMigrationFiles(files: string[]): string[] {
  const num = (f: string): number => {
    const m = /^(\d+)_/.exec(f);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return [...files].sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Banco novo (sibling na mesma instância do `baseUrl`) com TODAS as migrations do diretório aplicadas. */
async function createEphemeralDbFullyMigrated(baseUrl: string): Promise<{ url: string; dbName: string; adminUrl: string }> {
  const dbName = `mig454_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // CREATE/DROP DATABASE não rodam dentro de uma conexão que já está NAQUELE banco — conecta no
  // banco original (`baseUrl`) só para criar o banco de teste como sibling.
  const adminUrlObj = new URL(baseUrl);
  const adminUrl = adminUrlObj.toString();
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await adminPool.end();
  }

  const testUrlObj = new URL(baseUrl);
  testUrlObj.pathname = `/${dbName}`;
  const testUrl = testUrlObj.toString();

  const files = sortMigrationFiles(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')));

  const pool = new Pool({ connectionString: testUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      // Silencia NOTICE/WARNING de migration para não poluir o log do teste (idem ao runner).
      const handler = () => undefined;
      client.on('notice', handler);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Falhou aplicando ${file} no banco efêmero ${dbName}: ${(err as Error).message}`);
      } finally {
        client.removeListener('notice', handler);
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  return { url: testUrl, dbName, adminUrl };
}

async function dropEphemeralDb(adminUrl: string, dbName: string): Promise<void> {
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await adminPool.end();
  }
}

/** Grupos vivos com `is_system = true` além do Acesso Master — deve ser SEMPRE vazio após a 454. */
async function gruposSistemaAlemDoMaster(pool: Pool): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM iam.permission_groups WHERE is_system = true AND id <> $1 ORDER BY name`,
    [ACESSO_MASTER_ID],
  );
  return rows;
}

describe('migration 454 (T254) — Super Admin não é grupo de sistema @repo — banco efêmero, migrado do zero (206→454)', () => {
  let pool: Pool;
  let dbName: string;
  let adminUrl: string;

  beforeAll(async () => {
    const created = await createEphemeralDbFullyMigrated(BASE_DATABASE_URL);
    dbName = created.dbName;
    adminUrl = created.adminUrl;
    pool = new Pool({ connectionString: created.url });
    await pool.query('SELECT 1');
  }, 600_000);

  afterAll(async () => {
    await pool.end();
    await dropEphemeralDb(adminUrl, dbName);
  }, 60_000);

  it('só o Acesso Master é is_system=true — nenhum outro grupo, Super Admin incluso', async () => {
    const anomalias = await gruposSistemaAlemDoMaster(pool);
    expect(anomalias).toEqual([]);
  });

  it('o Super Admin (id fixo a0000000-...-005) especificamente tem is_system=false', async () => {
    const { rows } = await pool.query<{ is_system: boolean }>(
      `SELECT is_system FROM iam.permission_groups WHERE id = $1`,
      [SUPER_ADMIN_ID],
    );
    expect(rows[0]?.is_system).toBe(false);
  });

  it('o Acesso Master continua is_system=true — a 454 não pode ter tocado nele', async () => {
    const { rows } = await pool.query<{ is_system: boolean }>(
      `SELECT is_system FROM iam.permission_groups WHERE id = $1`,
      [ACESSO_MASTER_ID],
    );
    expect(rows[0]?.is_system).toBe(true);
  });

  it('rodar a 454 de novo é no-op (idempotência) — reaplicar não muda contagem nem a flag', async () => {
    const antesDoRerun = await gruposSistemaAlemDoMaster(pool);
    const sql454 = fs.readFileSync(path.join(MIGRATIONS_DIR, '454_super_admin_nao_e_grupo_de_sistema.sql'), 'utf8');
    await pool.query(sql454);
    const depoisDoRerun = await gruposSistemaAlemDoMaster(pool);
    expect(depoisDoRerun).toEqual(antesDoRerun);
    expect(depoisDoRerun).toEqual([]);
  });
});
