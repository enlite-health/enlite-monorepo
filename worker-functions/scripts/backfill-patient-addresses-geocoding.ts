/**
 * backfill-patient-addresses-geocoding.ts
 *
 * Backfill script: geocodifica `patient_addresses` que ainda não têm `lat`/`lng`
 * (legacy ClickUp imports antes da migration 153 + plug do GeocodingService no
 * upsert). Idempotente — só toca linhas com `lat IS NULL OR lng IS NULL`.
 *
 * Estratégia:
 *   - Busca todos os endereços sem coords
 *   - Monta a query usando `address_formatted` (preferido) ou `address_raw +
 *     neighborhood + city + state + country` como fallback
 *   - Usa `GeocodingService.geocodeBatch` (rate-limited, retry em
 *     OVER_QUERY_LIMIT)
 *   - UPDATE em lotes de 50 dentro de uma transação
 *
 * Uso:
 *   npx ts-node -r dotenv/config scripts/backfill-patient-addresses-geocoding.ts
 *   npx ts-node -r dotenv/config scripts/backfill-patient-addresses-geocoding.ts --dry-run
 *   npx ts-node -r dotenv/config scripts/backfill-patient-addresses-geocoding.ts --limit 50
 *
 * Custo: Google Maps Geocoding API ≈ $5 / 1000 chamadas. ~600 endereços ≈ $3.
 */

import { Pool } from 'pg';
import { GeocodingService } from '../src/infrastructure/services/GeocodingService';

interface AddressRow {
  id: string;
  address_formatted: string | null;
  address_raw: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1] ?? '0', 10) : 0;

const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 200;
const COUNTRY = 'AR';

function buildQuery(row: AddressRow): string | null {
  const formatted = row.address_formatted?.trim();
  if (formatted) return formatted;

  const raw = row.address_raw?.trim();
  if (!raw) return null;

  return [raw, row.neighborhood?.trim(), row.city?.trim(), row.state?.trim(), 'Argentina']
    .filter((p): p is string => !!p)
    .join(', ');
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const geocoder = new GeocodingService();

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ GOOGLE_MAPS_API_KEY not set — aborting.');
    process.exit(1);
  }

  console.log(`[backfill-geocoding] mode=${isDryRun ? 'DRY RUN' : 'EXECUTE'}${limit ? ` limit=${limit}` : ''}`);

  const { rows: candidates } = await pool.query<AddressRow>(
    `SELECT id, address_formatted, address_raw, neighborhood, city, state
       FROM patient_addresses
      WHERE (lat IS NULL OR lng IS NULL)
        AND (
          NULLIF(TRIM(address_formatted), '') IS NOT NULL OR
          NULLIF(TRIM(address_raw), '')       IS NOT NULL
        )
      ORDER BY created_at ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}`,
  );

  console.log(`[backfill-geocoding] candidates=${candidates.length}`);

  let resolved = 0;
  let unresolved = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const queries: (string | null)[] = batch.map(buildQuery);

    const indexedQueries = queries
      .map((q, idx) => ({ q, idx }))
      .filter((x): x is { q: string; idx: number } => x.q !== null);

    skipped += batch.length - indexedQueries.length;
    if (indexedQueries.length === 0) continue;

    const results = await geocoder.geocodeBatch(
      indexedQueries.map((x) => x.q),
      COUNTRY,
      RATE_LIMIT_MS,
    );

    if (isDryRun) {
      results.forEach((res, k) => {
        const original = batch[indexedQueries[k].idx];
        if (res) {
          console.log(`  ✓ ${original.id} → ${res.latitude}, ${res.longitude}`);
          resolved++;
        } else {
          console.log(`  ✗ ${original.id} → NO RESULT for "${indexedQueries[k].q.slice(0, 60)}"`);
          unresolved++;
        }
      });
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let k = 0; k < results.length; k++) {
        const res = results[k];
        const original = batch[indexedQueries[k].idx];
        if (!res) {
          unresolved++;
          continue;
        }
        await client.query(
          'UPDATE patient_addresses SET lat = $1, lng = $2, updated_at = now() WHERE id = $3',
          [res.latitude, res.longitude, original.id],
        );
        resolved++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[backfill-geocoding] batch ${i / BATCH_SIZE} failed:`, err);
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `[backfill-geocoding] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidates.length / BATCH_SIZE)} done — resolved=${resolved} unresolved=${unresolved} skipped=${skipped}`,
    );
  }

  console.log(`[backfill-geocoding] DONE — resolved=${resolved} unresolved=${unresolved} skipped=${skipped}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill-geocoding] FATAL:', err);
  process.exit(1);
});
