#!/usr/bin/env node
/**
 * Idempotent seed runner for development environments.
 * Executes all .sql files in /app/seeds in alphabetical order.
 * Seeds must use ON CONFLICT DO NOTHING to be safe to re-run.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

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
  if (!fs.existsSync(SEEDS_DIR)) {
    console.log('No seeds directory found — skipping.');
    return;
  }

  const files = fs
    .readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No seed files found — skipping.');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    await waitForDB(pool);

    for (const file of files) {
      const sql = fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`🌱 Seeded: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn(`⚠️  Skipped: ${file} — ${err.message}`);
      } finally {
        client.release();
      }
    }

    console.log(`\n✅ Seeds complete — ${files.length} file(s) applied.`);
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Seed runner error:', err);
  process.exit(1);
});
