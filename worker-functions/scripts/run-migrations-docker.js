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

function createPool() {
  // Cloud Run: DB_HOST is a unix socket path like /cloudsql/project:region:instance
  if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
    return new Pool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
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

    // Advisory lock prevents race condition when Cloud Run starts multiple instances
    const LOCK_ID = 20241201; // arbitrary fixed int
    const lockResult = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_ID]);
    if (!lockResult.rows[0].acquired) {
      console.log('⏳ Another instance is running migrations — skipping.');
      return;
    }

    try {
      // Load already-applied migrations
      const { rows } = await pool.query('SELECT filename FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.filename));

      // List all .sql files, sorted alphabetically (stable order)
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      let ran = 0;
      let skipped = 0;

      for (const file of files) {
        if (applied.has(file)) {
          skipped++;
          continue;
        }

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        const client = await pool.connect();
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
      await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration runner error:', err);
  process.exit(1);
});
