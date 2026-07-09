/**
 * normalize-worker-provinces.ts
 *
 * Normaliza `worker_service_areas.state` (provincia) para a forma canônica em
 * espanhol, desfragmentando rótulos que o Google Maps devolveu inconsistentes
 * ("Buenos Aires Province" / "Buenos Aires" / "Córdoba Province"). Determinístico:
 * NÃO chama o Google — usa a SSOT `canonicalProvince` (mesma regra do write-path
 * do geocoding). Idempotente (só toca linhas cujo canônico difere do atual).
 *
 * Uso:
 *   npx ts-node -r dotenv/config scripts/normalize-worker-provinces.ts --dry-run
 *   npx ts-node -r dotenv/config scripts/normalize-worker-provinces.ts
 */

import { Pool } from 'pg';
import { canonicalProvince } from '../src/shared/utils/normalizeLocationValue';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const isDryRun = process.argv.includes('--dry-run');

interface Row {
  id: string;
  state: string | null;
  city: string | null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  console.log(`[normalize-provinces] mode=${isDryRun ? 'DRY RUN' : 'EXECUTE'}`);

  const { rows } = await pool.query<Row>(
    `SELECT id, state, city FROM worker_service_areas
      WHERE deleted_at IS NULL AND state IS NOT NULL AND btrim(state) <> ''`,
  );

  const changes = new Map<string, number>(); // "from → to" → count
  let updated = 0;

  const client = await pool.connect();
  try {
    if (!isDryRun) await client.query('BEGIN');
    for (const row of rows) {
      const canon = canonicalProvince(row.state, row.city);
      if (!canon || canon === row.state) continue;
      const key = `${row.state} → ${canon}`;
      changes.set(key, (changes.get(key) ?? 0) + 1);
      updated++;
      if (!isDryRun) {
        await client.query('UPDATE worker_service_areas SET state = $1, updated_at = now() WHERE id = $2', [canon, row.id]);
      }
    }
    if (!isDryRun) await client.query('COMMIT');
  } catch (err) {
    if (!isDryRun) await client.query('ROLLBACK');
    console.error('[normalize-provinces] FAILED — rolled back:', err);
    throw err;
  } finally {
    client.release();
  }

  for (const [k, n] of [...changes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }
  console.log(`[normalize-provinces] DONE — ${isDryRun ? 'would update' : 'updated'}=${updated} (de ${rows.length} com provincia)`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[normalize-provinces] FATAL:', err);
    process.exit(1);
  });
}
