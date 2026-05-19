/**
 * backfill-worker-service-areas-geocoding.ts
 *
 * Backfill: geocodifica `worker_service_areas` que ainda nao tem coords reais
 * (legacy ClickUp imports + workers cujo geocoding falhou no fluxo de cadastro).
 * Idempotente — so toca linhas com lat/lng NULL ou sentinela (0, 0) da migration 159.
 *
 * A coluna `location` (geography) e GENERATED de latitude/longitude, entao
 * UPDATE em lat/lng atualiza `location` automaticamente.
 *
 * Estrategia:
 *   - Busca wsa sem coords com address_line preenchido
 *   - Monta query: `address_line + neighborhood + city + state + country`
 *   - Usa `GeocodingService.geocodeBatch` (rate-limited, retry em OVER_QUERY_LIMIT)
 *   - UPDATE em lotes de 50 dentro de uma transacao
 *
 * Uso:
 *   npx ts-node -r dotenv/config scripts/backfill-worker-service-areas-geocoding.ts --dry-run
 *   npx ts-node -r dotenv/config scripts/backfill-worker-service-areas-geocoding.ts --limit 50
 *   npx ts-node -r dotenv/config scripts/backfill-worker-service-areas-geocoding.ts
 *
 * Custo: Google Maps Geocoding API ~$5/1000 chamadas.
 */

import { Pool } from 'pg';
import { GeocodingService } from '../src/infrastructure/services/GeocodingService';

interface ServiceAreaRow {
  id: string;
  worker_id: string;
  address_line: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1] ?? '0', 10) : 0;

const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 200;
const DEFAULT_COUNTRY = 'AR';

function buildQuery(row: ServiceAreaRow): string | null {
  const line = row.address_line?.trim();
  if (!line) return null;

  // Se address_line já parece formatado pelo Google Maps (já contém "Argentina"
  // ou "Brasil"), usa direto — evita duplicar componentes e confundir o geocoder.
  if (/argentina|brasil|brazil/i.test(line)) return line;

  return [line, row.neighborhood?.trim(), row.city?.trim(), row.state?.trim(), 'Argentina']
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

  console.log(`[backfill-worker-geo] mode=${isDryRun ? 'DRY RUN' : 'EXECUTE'}${limit ? ` limit=${limit}` : ''}`);

  const { rows: candidates } = await pool.query<ServiceAreaRow>(
    `SELECT id, worker_id, address_line, neighborhood, city, state, country
       FROM worker_service_areas
      WHERE deleted_at IS NULL
        AND (
          latitude IS NULL
          OR longitude IS NULL
          OR (latitude = 0 AND longitude = 0)
        )
        AND NULLIF(TRIM(address_line), '') IS NOT NULL
      ORDER BY created_at ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}`,
  );

  console.log(`[backfill-worker-geo] candidates=${candidates.length}`);

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

    // Sempre AR — único mercado ativo. Coluna country tem ruído (default antigo 'BR').
    const results = await geocoder.geocodeBatch(
      indexedQueries.map((x) => x.q),
      DEFAULT_COUNTRY,
      RATE_LIMIT_MS,
    );

    if (isDryRun) {
      results.forEach((res, k) => {
        const original = batch[indexedQueries[k].idx];
        if (res) {
          console.log(`  ✓ wsa=${original.id} worker=${original.worker_id} → ${res.latitude}, ${res.longitude}`);
          resolved++;
        } else {
          console.log(`  ✗ wsa=${original.id} worker=${original.worker_id} → NO RESULT for "${indexedQueries[k].q.slice(0, 80)}"`);
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
          'UPDATE worker_service_areas SET latitude = $1, longitude = $2, updated_at = now() WHERE id = $3',
          [res.latitude, res.longitude, original.id],
        );
        resolved++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[backfill-worker-geo] batch ${i / BATCH_SIZE} failed:`, err);
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `[backfill-worker-geo] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidates.length / BATCH_SIZE)} done — resolved=${resolved} unresolved=${unresolved} skipped=${skipped}`,
    );
  }

  console.log(`[backfill-worker-geo] DONE — resolved=${resolved} unresolved=${unresolved} skipped=${skipped}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill-worker-geo] FATAL:', err);
  process.exit(1);
});
