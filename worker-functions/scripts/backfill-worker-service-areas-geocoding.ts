/**
 * backfill-worker-service-areas-geocoding.ts
 *
 * Backfill de geocodificação de `worker_service_areas`. Preenche, de forma
 * IDEMPOTENTE e sem sobrescrever dado bom:
 *   - latitude/longitude ausentes (NULL ou sentinela 0,0 da migration 159)
 *   - state (provincia) vazio
 *   - city (localidad) vazio OU lixo de CPA argentino ('AEJ','BSI'... → ^[A-Z]{2,4}$)
 *
 * Fonte da query de geocoding, por linha:
 *   1. address_line (quando preenchido — fluxo do app via Maps)
 *   2. senão, a zona de texto livre: work_zone → interest_zone (imports legados
 *      do ClickUp, que têm só "Flores"/"CABA"/"Avellaneda" e nunca city/state)
 *
 * `GeocodingService.geocode` devolve city (locality/admin_area_2) + state
 * (admin_area_1) + lat/lng, e já descarta resultados imprecisos (isPreciseEnough),
 * então zonas genéricas ("Oeste","Centro") não escrevem lixo — ficam como estão.
 *
 * Dedup por string de query (≈342 zonas distintas p/ ~475 linhas) → menos chamadas.
 * A coluna `location` (geography) é GENERATED de lat/lng — atualiza sozinha.
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
import { canonicalProvince } from '../src/shared/utils/normalizeLocationValue';

interface ServiceAreaRow {
  id: string;
  worker_id: string;
  address_line: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  work_zone: string | null;
  interest_zone: string | null;
  latitude: number | null;
  longitude: number | null;
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

/** CPA argentino escrito errado em `city` por import legado (ex.: "AEJ","BSI"). */
function isJunkCity(city: string | null): boolean {
  return !!city && /^[A-Z]{2,4}$/.test(city.trim());
}
function isEmpty(v: string | null): boolean {
  return !v || v.trim() === '';
}
function coordsMissing(row: ServiceAreaRow): boolean {
  return (
    row.latitude === null ||
    row.longitude === null ||
    (row.latitude === 0 && row.longitude === 0)
  );
}

/** Remove tokens de CPA argentino ("B1832 AOO", "C1426BSI", "B1748") que
 * confundem o geocoder e vazam o sufixo-lixo pra city. */
export function stripCpa(s: string): string {
  return s
    .replace(/\b[A-Z]\d{4}\s*[A-Z]{2,4}\b/g, '')
    .replace(/\b[A-Z]\d{4}\b/g, '')
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,]+$/, '')
    .replace(/^[\s,]+/, '')
    .trim();
}

export interface GeoQuery {
  query: string;
  /** true = query veio da ZONA livre → aceita resultado nível partido (allowCoarse). */
  coarse: boolean;
}

/** Constrói a query de geocoding: address_line (CPA removido) quando houver;
 * senão a zona livre (coarse). Exclui city-lixo da composição. */
export function buildQuery(row: ServiceAreaRow): GeoQuery | null {
  const line = row.address_line?.trim();
  if (line) {
    const cleaned = stripCpa(line);
    if (/argentina|brasil|brazil/i.test(cleaned)) return { query: cleaned, coarse: false };
    const cityPart = row.city?.trim() && !isJunkCity(row.city) ? row.city.trim() : null;
    const query = [cleaned, row.neighborhood?.trim(), cityPart, row.state?.trim(), 'Argentina']
      .filter((p): p is string => !!p)
      .join(', ');
    return { query, coarse: false };
  }
  const zone = row.work_zone?.trim() || row.interest_zone?.trim();
  if (zone) return { query: `${zone}, Argentina`, coarse: true };
  return null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const geocoder = new GeocodingService();

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ GOOGLE_MAPS_API_KEY not set — aborting.');
    process.exit(1);
  }

  console.log(`[backfill-worker-geo] mode=${isDryRun ? 'DRY RUN' : 'EXECUTE'}${limit ? ` limit=${limit}` : ''}`);

  // Candidatos: falta coords OU falta state OU city vazia/lixo — e há alguma
  // fonte de geocoding (address_line OU zona livre).
  const { rows: candidates } = await pool.query<ServiceAreaRow>(
    `SELECT id, worker_id, address_line, neighborhood, city, state,
            work_zone, interest_zone, latitude, longitude
       FROM worker_service_areas
      WHERE deleted_at IS NULL
        AND (
          latitude IS NULL OR longitude IS NULL OR (latitude = 0 AND longitude = 0)
          OR state IS NULL OR btrim(state) = ''
          OR city IS NULL OR btrim(city) = '' OR city ~ '^[A-Z]{2,4}$'
        )
        AND (
          NULLIF(btrim(address_line), '') IS NOT NULL
          OR NULLIF(btrim(work_zone), '') IS NOT NULL
          OR NULLIF(btrim(interest_zone), '') IS NOT NULL
        )
      ORDER BY created_at ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}`,
  );

  console.log(`[backfill-worker-geo] candidates=${candidates.length}`);

  // Dedup por query — geocoda cada string única uma vez. Separa precise
  // (address) de coarse (zona → aceita nível partido).
  const queryByRow = new Map<string, string>(); // rowId → query
  const precise = new Set<string>();
  const coarse = new Set<string>();
  for (const row of candidates) {
    const q = buildQuery(row);
    if (q) {
      queryByRow.set(row.id, q.query);
      (q.coarse ? coarse : precise).add(q.query);
    }
  }
  console.log(`[backfill-worker-geo] queries: precise=${precise.size} coarse=${coarse.size} (skipped ${candidates.length - queryByRow.size} sem fonte)`);

  // Geocoda em lotes; monta mapa query → resultado.
  const resultByQuery = new Map<string, { city: string | null; state: string | null; latitude: number; longitude: number } | null>();
  const geocodeSet = async (queries: string[], allowCoarse: boolean): Promise<void> => {
    for (let i = 0; i < queries.length; i += BATCH_SIZE) {
      const slice = queries.slice(i, i + BATCH_SIZE);
      const results = await geocoder.geocodeBatch(slice, DEFAULT_COUNTRY, RATE_LIMIT_MS, { allowCoarse });
      slice.forEach((q, k) => resultByQuery.set(q, results[k] ?? null));
    }
  };
  await geocodeSet([...precise], false);
  await geocodeSet([...coarse], true);
  console.log(`[backfill-worker-geo] geocoded ${resultByQuery.size} unique queries`);

  // Região da operação — zona (coarse) sem contexto que resolve para província
  // distante é quase sempre um match errado do Google ("Mitre"→Santiago del
  // Estero); só confiamos em Buenos Aires / CABA e mandamos o resto pra ops.
  const OPERATING = new Set(['Provincia de Buenos Aires', 'Ciudad Autónoma de Buenos Aires']);
  const flagged = new Map<string, number>(); // zona → nº (pra revisão humana)
  const flag = (z: string): void => { flagged.set(z, (flagged.get(z) ?? 0) + 1); };

  let updated = 0;
  let unresolved = 0;
  const client = await pool.connect();
  try {
    if (!isDryRun) await client.query('BEGIN');
    for (const row of candidates) {
      const q = queryByRow.get(row.id);
      if (!q) continue;
      const res = resultByQuery.get(q);
      if (!res) {
        unresolved++;
        flag(q);
        continue;
      }
      const canonState = canonicalProvince(res.state, res.city);
      // Guard: resultado coarse (de zona) fora de Buenos Aires/CABA = provável
      // match errado de nome ambíguo — não escreve, vai pra ops.
      if (coarse.has(q) && (!canonState || !OPERATING.has(canonState))) {
        unresolved++;
        flag(q);
        continue;
      }
      const willCoords = coordsMissing(row);
      const willState = isEmpty(row.state) && !!canonState;
      const willCity = (isEmpty(row.city) || isJunkCity(row.city)) && !!res.city;
      if (!willCoords && !willState && !willCity) continue;

      if (isDryRun) {
        const parts: string[] = [];
        if (willCoords) parts.push(`coords→${res.latitude.toFixed(4)},${res.longitude.toFixed(4)}`);
        if (willState) parts.push(`state→${canonState}`);
        if (willCity) parts.push(`city→${res.city}`);
        console.log(`  ✓ wsa=${row.id} worker=${row.worker_id} "${q.slice(0, 50)}" ${parts.join(' ')}`);
        updated++;
        continue;
      }

      // UPDATE guardado: só toca o que está faltando/lixo; nunca sobrescreve dado bom.
      await client.query(
        `UPDATE worker_service_areas SET
           latitude  = CASE WHEN (latitude IS NULL OR longitude IS NULL OR (latitude=0 AND longitude=0)) THEN $1 ELSE latitude END,
           longitude = CASE WHEN (latitude IS NULL OR longitude IS NULL OR (latitude=0 AND longitude=0)) THEN $2 ELSE longitude END,
           state = CASE WHEN (state IS NULL OR btrim(state)='') AND $3::text IS NOT NULL THEN $3 ELSE state END,
           city  = CASE WHEN (city IS NULL OR btrim(city)='' OR city ~ '^[A-Z]{2,4}$') AND $4::text IS NOT NULL THEN $4 ELSE city END,
           updated_at = now()
         WHERE id = $5`,
        [res.latitude, res.longitude, canonState, res.city, row.id],
      );
      updated++;
    }

    // Limpeza final: city que restou como lixo de CPA (geocoding não recuperou a
    // localidad) vira NULL — melhor vazio que "AOO". state/coords ficam intactos.
    const junkSql = `city ~ '^[A-Z]{2,4}$'`;
    if (isDryRun) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*) n FROM worker_service_areas WHERE deleted_at IS NULL AND ${junkSql}`,
      );
      console.log(`[backfill-worker-geo] junk cities a limpar (→NULL): ${rows[0].n}`);
    } else {
      const r = await client.query(
        `UPDATE worker_service_areas SET city = NULL, updated_at = now() WHERE deleted_at IS NULL AND ${junkSql}`,
      );
      console.log(`[backfill-worker-geo] junk cities limpas (→NULL): ${r.rowCount}`);
    }

    if (!isDryRun) await client.query('COMMIT');
  } catch (err) {
    if (!isDryRun) await client.query('ROLLBACK');
    console.error('[backfill-worker-geo] FAILED — rolled back:', err);
    throw err;
  } finally {
    client.release();
  }

  if (flagged.size > 0) {
    console.log(`[backfill-worker-geo] PARA OPS — ${flagged.size} zonas não-resolvíveis (worker precisa esclarecer):`);
    for (const [z, n] of [...flagged.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(3)}  ${z.replace(/, Argentina$/, '')}`);
    }
  }
  console.log(`[backfill-worker-geo] DONE — ${isDryRun ? 'would update' : 'updated'}=${updated} unresolved=${unresolved}`);
  await pool.end();
}

// Só executa quando rodado como script (não quando importado por um teste).
if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-worker-geo] FATAL:', err);
    process.exit(1);
  });
}
