/**
 * migration434.repo.test.ts — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a
 * migration 434 (spec 019, gate `revisao-pr`, achado K2).
 *
 * Prova automatizada do conserto: o passo 0 (re-backfill) da 434 tinha DOIS bugs na janela entre
 * o deploy do código novo e a migration rodar —
 *
 *   (a) reafirmava `is_default = true` na linha `'primary'` legada mesmo quando o PATCH novo já
 *       tinha trocado o principal do paciente para OUTRO endereço — criando um segundo principal
 *       ativo (violação do índice único `patient_addresses_one_default_per_patient`, migration
 *       433) e derrubando a migration INTEIRA (nada aplica pela metade, spec.md linha 88);
 *   (b) o passo 5 apagava QUALQUER `address_type` não-nulo em linha ativa, inclusive um valor da
 *       lista NOVA que o PATCH já tivesse gravado (ex.: 'escuela').
 *
 * O conserto: (a) o backfill só reafirma quando `NOT EXISTS` outro principal ativo do mesmo
 * paciente; (b) o apagamento do passo 5 é restrito a `address_type IN ('primary','secondary',
 * 'tertiary','service')` — nunca a um valor da lista nova.
 *
 * SELF-CONTAINED (rodada 2, achado do orquestrador): a versão anterior deste arquivo exigia um
 * banco "só até a 433" fornecido de fora — falha contra QUALQUER banco já totalmente migrado
 * (inclusive o `enlite_e2e` normal de `run-migrations-docker.js`). Agora o próprio teste monta o
 * cenário: cria um banco EFÊMERO próprio (`CREATE DATABASE`, nome único por execução), aplica só
 * as migrations com prefixo numérico <= 433 (mesma ordenação de `run-migrations-docker.js`,
 * reaproveitada aqui — ver `sortMigrationFiles`), roda a 434 manualmente (é o objeto do teste) e
 * derruba o banco no `afterAll`. Fica indiferente ao estado do `DATABASE_URL` de fora: passa igual
 * num container recém-criado ou num que já rodou as 434 migrations inteiras, porque não usa esse
 * banco para nada além de descobrir os parâmetros de conexão (host/porta/usuário/senha) e criar o
 * banco de teste como sibling na mesma instância Postgres.
 *
 * Como rodar (basta UM Postgres de pé, migrado ou não):
 *   docker run -d --name 019fix-pg -p 127.0.0.1:5450:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5450/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand migration434
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const BASE_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5450/enlite_e2e';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

const MIGRATION_434_SQL = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '434_patient_addresses_address_type_contract.sql'),
  'utf8',
);

/** Mesma regra de ordenação de `scripts/run-migrations-docker.js` (prefixo numérico, empate por nome CRU). */
function sortMigrationFiles(files: string[]): string[] {
  const num = (f: string): number => {
    const m = /^(\d+)_/.exec(f);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return [...files].sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Banco novo (sibling na mesma instância do `baseUrl`) só com migrations até `maxPrefix` (inclusive). */
async function createEphemeralDbUpTo(baseUrl: string, maxPrefix: number): Promise<{ url: string; dbName: string; adminUrl: string }> {
  const parsed = new URL(baseUrl);
  const dbName = `mig434_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
  const upToFiles = files.filter((f) => {
    const m = /^(\d+)_/.exec(f);
    const n = m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
    return n <= maxPrefix;
  });

  const pool = new Pool({ connectionString: testUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (const file of upToFiles) {
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
    // Derruba conexões residuais antes do DROP (o pool de teste já foi encerrado em afterAll,
    // mas outra ferramenta pode ter aberto uma sessão de inspeção nesse meio-tempo).
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await adminPool.end();
  }
}

describe('migration 434 (contract) @repo — banco efêmero próprio, migrado só até a 433', () => {
  let pool: Pool;
  let dbName: string;
  let adminUrl: string;
  const patientIds: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };

  beforeAll(async () => {
    const created = await createEphemeralDbUpTo(BASE_DATABASE_URL, 433);
    dbName = created.dbName;
    adminUrl = created.adminUrl;
    pool = new Pool({ connectionString: created.url });
    await pool.query('SELECT 1');

    // Confere a pré-condição mesmo assim (defesa em profundidade: se o banco efêmero nasceu
    // errado, falha aqui em vez de um erro de constraint confuso mais abaixo).
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'patient_addresses_type_check'
       ) AS exists`,
    );
    if (rows[0].exists) {
      throw new Error('Banco efêmero nasceu com a 434 já aplicada — bug na criação do fixture deste teste.');
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await dropEphemeralDb(adminUrl, dbName);
  }, 30_000);

  beforeEach(async () => {
    for (const key of ['A', 'B', 'C'] as const) {
      const { rows: [p] } = await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'K2', $2, 'AR', 'ACTIVE') RETURNING id`,
        [`k2-migration-434-${key}-${Date.now()}-${Math.random()}`, key],
      );
      patientIds[key] = p.id;
    }
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1::uuid[])`, [Object.values(patientIds)]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [Object.values(patientIds)]);
  });

  it('backfill (passo 0) não cria segundo principal quando o PATCH novo já trocou; passo 5 preserva tipo novo já gravado (ex.: escuela)', async () => {
    // Paciente A: 'primary' ativa (is_default=false, código velho) + 'secondary' ativa já
    // marcada is_default=true (operador trocou via PATCH novo nessa janela).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'A - primary', 1, 'primary', false, 'admin_manual'),
              ($1, 'A - secondary', 2, 'secondary', true, 'admin_manual')`,
      [patientIds.A],
    );
    // Paciente B: já com 'escuela' (PATCH novo já rodou).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'B - escuela', 1, 'escuela', true, 'admin_manual')`,
      [patientIds.B],
    );
    // Paciente C: 'primary' sem is_default (código antigo na janela).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'C - primary', 1, 'primary', false, 'admin_manual')`,
      [patientIds.C],
    );
    // Linha arquivada de A com valor legado — nunca deve ser tocada.
    const { rows: [arquivada] } = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, archived_at, source)
       VALUES ($1, 'A - arquivada', 3, 'primary', false, NOW(), 'admin_manual') RETURNING id`,
      [patientIds.A],
    );

    await pool.query(MIGRATION_434_SQL);

    const { rows: aRows } = await pool.query<{ address_type: string | null; is_default: boolean }>(
      `SELECT address_type, is_default FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL ORDER BY display_order`,
      [patientIds.A],
    );
    expect(aRows).toEqual([
      { address_type: null, is_default: false }, // a antiga 'primary' NÃO virou principal de novo
      { address_type: null, is_default: true },  // a 'secondary' continua a única principal
    ]);
    const { rows: [aCount] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
      [patientIds.A],
    );
    expect(aCount.n).toBe('1'); // nunca 0, nunca 2

    const { rows: [bRow] } = await pool.query<{ address_type: string | null }>(
      `SELECT address_type FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`,
      [patientIds.B],
    );
    expect(bRow.address_type).toBe('escuela'); // preservado, não é valor legado

    const { rows: [cRow] } = await pool.query<{ address_type: string | null; is_default: boolean }>(
      `SELECT address_type, is_default FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`,
      [patientIds.C],
    );
    expect(cRow).toEqual({ address_type: null, is_default: true }); // backfill normal, sem colisão

    const { rows: [arquivadaRow] } = await pool.query<{ address_type: string | null }>(
      `SELECT address_type FROM patient_addresses WHERE id = $1`,
      [arquivada.id],
    );
    expect(arquivadaRow.address_type).toBe('primary'); // arquivada nunca tocada
  });
});
