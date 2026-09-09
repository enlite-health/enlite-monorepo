#!/usr/bin/env node
/**
 * Idempotent migration runner for Docker/local environments.
 * Uses DATABASE_URL env var and a schema_migrations tracking table.
 * Safe to run multiple times — already-applied migrations are skipped.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Ordem de aplicação: pelo PREFIXO NUMÉRICO, não pelo nome.
 * Hoje é no-op (as 338 migrations têm 3 dígitos), e é exatamente por isso que a troca é barata:
 * com `.sort()` lexicográfico, a primeira `1000_` seria aplicada ANTES da `323_` — silenciosamente,
 * numa ordem que nenhuma review pega. Empate (mesmo número) cai no nome com comparação CRUA (`<`),
 * NUNCA `localeCompare`: há duas `040_consolidate_clickup_columns*.sql` no repo e a colação de locale
 * as inverte — trocar a ordem de migrations já aplicadas é a mudança silenciosa que este arquivo não
 * pode fazer (medido pelo próprio teste, que reprovou a 1ª versão).
 */
function sortMigrationFiles(files) {
  const num = (f) => {
    const m = /^(\d+)_/.exec(f);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; // sem prefixo numérico: por último, pelo nome
  };
  return [...files].sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `RAISE WARNING`/`NOTICE` de dentro de uma migration só chega ao log se ALGUÉM escutar: o `pg`
 * emite o evento `notice` e, sem listener, o Node o descarta. Medido em 09/09/2026 (gate da 419):
 * a 273 promete por escrito que o aviso "aparece no log de deploy" para o caso em que ela não
 * consegue conceder — e não aparecia. Migration que passa sem fazer o que diz é o pior dos mundos:
 * fica registrada como aplicada e não volta a rodar.
 */
function attachNoticeLogger(client, file) {
  client.on('notice', (n) => {
    const onde = file ? ` (${file})` : '';
    console.warn(`⚠️  [${n.severity || 'NOTICE'}]${onde} ${n.message}${n.hint ? ` — ${n.hint}` : ''}`);
  });
}

function createPool() {
  // Cloud Run: DB_HOST is a unix socket path like /cloudsql/project:region:instance
  if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
    // Migrations precisam do OWNER das tabelas (ALTER TABLE, DROP POLICY, SET SCHEMA,
    // CREATE FUNCTION SECURITY DEFINER, INSERT em schema_migrations — todos exigem
    // ownership). Desde a virada do ABAC (D112) o serviço conecta como enlite_runtime
    // (confinado, não-owner) — se o runner usasse essa credencial, a 1ª migration
    // com DDL de owner quebraria o boot (achado 16/08, PR #223). Por isso o runner
    // usa DB_MIGRATION_USER/DB_MIGRATION_PASSWORD (= enlite_app) quando existirem, e
    // cai em DB_USER/DB_PASSWORD onde ainda não há separação (prod hoje, local).
    const user = process.env.DB_MIGRATION_USER || process.env.DB_USER;
    const password = process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD;
    if (process.env.DB_MIGRATION_USER) {
      console.log(`[migrations] conectando como ${user} (DB_MIGRATION_USER, credencial de owner)`);
    } else {
      console.log(`[migrations] conectando como ${user} (DB_USER — sem DB_MIGRATION_USER definido)`);
    }
    return new Pool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user,
      password,
    });
  }
  // Docker/local: DATABASE_URL connection string
  const DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
  return new Pool({ connectionString: DATABASE_URL });
}

async function waitForDB(pool, attempts = 30, delayMs = 1000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`⏳ DB not ready (attempt ${i}/${attempts}) — ${err.code || err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function run() {
  const pool = createPool();

  try {
    await waitForDB(pool);

    // Ensure tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Advisory lock serializa instâncias concorrentes (Cloud Run sobe N; worker-functions
    // e MCP compartilham a imagem). BLOQUEANTE de propósito (achado do gate #223): com
    // try_lock a instância perdedora pulava e subia o app com o schema a meio (ex.:
    // iam.effective_countries ainda inexistente). Agora ela ESPERA o vencedor terminar e
    // relê schema_migrations — sobe só com o schema completo.
    const LOCK_ID = 20241201; // arbitrary fixed int
    const lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    console.log('🔒 Migration lock acquired');

    try {
      // Load already-applied migrations (APÓS o lock: o vencedor pode ter aplicado tudo)
      const { rows } = await pool.query('SELECT filename FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.filename));

      // List all .sql files, sorted alphabetically (stable order)
      const files = sortMigrationFiles(
        fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
      );

      let ran = 0;
      let skipped = 0;

      for (const file of files) {
        if (applied.has(file)) {
          skipped++;
          continue;
        }

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        const client = await pool.connect();
        attachNoticeLogger(client, file);
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1)',
            [file]
          );
          await client.query('COMMIT');
          console.log(`✅ Applied: ${file}`);
          ran++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ Failed: ${file}`);
          console.error(err.message);
          process.exit(1);
        } finally {
          client.release();
        }
      }

      console.log(`\n🎉 Migrations complete — ${ran} applied, ${skipped} skipped.`);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
      lockClient.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration runner error:', err);
    process.exit(1);
  });
}

module.exports = { sortMigrationFiles, attachNoticeLogger };
