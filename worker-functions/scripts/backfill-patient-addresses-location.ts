/**
 * backfill-patient-addresses-location.ts
 *
 * Fase 1 — cleanup dos campos estruturados (`state`, `city`, `neighborhood`)
 * de `patient_addresses`, e geocodificação dos endereços legados que nunca
 * passaram pelo Google Geocoding. Ver docs/HANDOFF (fase-1-enderecos).
 *
 * Contexto (prod, verificado antes desta implementação):
 *   - 298 rows com `address_formatted` já em padrão Google Maps, mas `state`
 *     misturado ES/EN/cidade, `city` com prefixo de CEP, `neighborhood` com a
 *     string literal 'null'.
 *   - 45 rows com `address_raw` real e `address_formatted` NULL — nunca
 *     geocodificadas.
 *   - 281 rows "casca vazia" (address_raw='null' + address_formatted=null) —
 *     EXCLUÍDAS por decisão de produto. NÃO TOCAR.
 *   - 357 rows sem lat/lng.
 *
 * Estratégia (toda a decisão de UPDATE vive em
 * `src/modules/case/infrastructure/backfillPatientAddressLocation.ts`, puro
 * e testado — este script só faz I/O):
 *   1. SELECT ativos (`archived_at IS NULL`) — ou, com
 *      `--include-archived-referenced`, ATIVOS + ARQUIVADOS ainda
 *      referenciados por `job_postings.patient_address_id` não deletada —
 *      excluindo cascas vazias em ambos os casos
 *      (`buildBackfillCandidatesPredicate`).
 *   2. Para cada row: monta a query de geocode (prefere address_formatted,
 *      senão address_raw + contexto) via `buildBackfillGeocodingQuery`.
 *   3. Geocodifica via `GeocodingService.geocodeBatch` (rate-limited).
 *   4. Calcula o plano de UPDATE via `buildBackfillPlan` — nunca sobrescreve
 *      `address_formatted` existente; `state`/`city`/`neighborhood`
 *      re-extraídos com os MESMOS helpers usados no import do ClickUp;
 *      `lat`/`lng` só quando a row ainda não tem coords.
 *   5. Falha de geocode (ZERO_RESULTS / erro) → linha reportada como
 *      unresolved, NUNCA alterada.
 *   6. Duas travas de segurança (achadas em dry-run manual contra prod —
 *      geocode "chutou" localização errada em endereços raw-only ambíguos):
 *        - PARTIAL_MATCH: Google relaxou parte da query pra achar QUALQUER
 *          resultado → tratado como unresolved, nunca escreve.
 *        - TOO_FAR: quando a row já tem lat/lng, resultado a mais de
 *          `TOO_FAR_KM_THRESHOLD` km do ponto existente → unresolved.
 *      Ver `classifyBackfillUnresolved` em backfillPatientAddressLocation.ts.
 *
 * Dry-run é o DEFAULT — sem `--apply` o script NUNCA escreve, só imprime o
 * relatório before→after por linha + contadores.
 *
 * Uso:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-patient-addresses-location.ts
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-patient-addresses-location.ts --apply
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-patient-addresses-location.ts --limit 20
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-patient-addresses-location.ts --exclude-ids 4b2ab006-62d8-4cfb-8cbd-b61d17651ce2,11111111-1111-1111-1111-111111111111
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-patient-addresses-location.ts --include-archived-referenced
 *
 * `--exclude-ids <uuid,uuid,...>`: rows manually flagged for human review
 * (e.g. a prior bad geocode that survives both the PARTIAL_MATCH and
 * TOO_FAR safety nets) are skipped BEFORE any geocode call — no API cost,
 * no write. Invalid UUIDs in the list abort the script before it connects
 * to the database (see `parseExcludeIdsArg`).
 *
 * `--include-archived-referenced`: WITHOUT this flag (default), only ACTIVE
 * rows (`archived_at IS NULL`) are scanned — the original Fase 1 scope. WITH
 * it, ARCHIVED rows still referenced by a non-deleted `job_postings.
 * patient_address_id` (migration 198 address versioning freezes the version
 * a vacancy points to) are ALSO scanned — found in prod: 231 non-deleted
 * job_postings point to archived address versions still carrying dirty
 * state/city, which `PublicJobsController`'s JOIN exposes on the public
 * site. Empty-shell rows stay excluded either way. Same fill-only rules
 * apply — `address_formatted` is never overwritten when already set; only
 * state/city/neighborhood are re-derived and lat/lng/address_formatted are
 * filled when null. See `buildBackfillCandidatesPredicate`.
 *
 * Requer: DATABASE_URL, GOOGLE_MAPS_API_KEY.
 * Custo: Google Maps Geocoding API ≈ $5 / 1000 chamadas. ~350 endereços ≈ $1.75.
 */

import { Pool } from 'pg';
import { GeocodingService } from '../src/infrastructure/services/GeocodingService';
import {
  isEmptyShellAddress,
  buildBackfillGeocodingQuery,
  buildBackfillPlan,
  classifyBackfillUnresolved,
  haversineDistanceKm,
  parseExcludeIdsArg,
  buildBackfillCandidatesPredicate,
  type BackfillAddressRow,
} from '../src/modules/case/infrastructure/backfillPatientAddressLocation';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const isApply = process.argv.includes('--apply');
const includeArchivedReferenced = process.argv.includes('--include-archived-referenced');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1] ?? '0', 10) : 0;

// Parsed/validated BEFORE anything touches the database (Pool/GeocodingService
// below) — a typo'd UUID must abort the run, not silently exclude nothing.
let excludeIds: string[];
try {
  excludeIds = parseExcludeIdsArg(process.argv);
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
}
const excludeIdsSet = new Set(excludeIds);

const BATCH_SIZE = 25;
const RATE_LIMIT_MS = 300;
const COUNTRY = 'AR';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const geocoder = new GeocodingService();

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ GOOGLE_MAPS_API_KEY not set — aborting.');
    process.exit(1);
  }

  console.log(`[backfill-address-location] mode=${isApply ? 'APPLY' : 'DRY RUN'}${limit ? ` limit=${limit}` : ''}${excludeIdsSet.size ? ` excludeIds=${excludeIdsSet.size}` : ''}${includeArchivedReferenced ? ' includeArchivedReferenced=true' : ''}`);

  // Excludes empty-shell rows (address_raw='null' literal + address_formatted
  // NULL) directly in SQL — belt-and-suspenders alongside isEmptyShellAddress()
  // below. Archived-row scope depends on --include-archived-referenced — see
  // buildBackfillCandidatesPredicate.
  const { rows: candidates } = await pool.query<BackfillAddressRow>(
    `SELECT id, address_formatted, address_raw, state, city, neighborhood,
            lat, lng
       FROM patient_addresses
      WHERE ${buildBackfillCandidatesPredicate({ includeArchivedReferenced })}
      ORDER BY created_at ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}`,
  );

  const nonShell = candidates.filter((row) => !isEmptyShellAddress(row));
  const shellSkipped = candidates.length - nonShell.length;

  const eligible = nonShell.filter((row) => !excludeIdsSet.has(row.id));
  const manuallyExcluded = nonShell.filter((row) => excludeIdsSet.has(row.id));
  for (const row of manuallyExcluded) {
    console.log(`  ⊘ EXCLUDED ${row.id} (manual review)`);
  }

  console.log(`[backfill-address-location] candidates=${candidates.length} (shell-excluded-defensively=${shellSkipped}) manuallyExcluded=${manuallyExcluded.length} eligible=${eligible.length}`);

  let resolved = 0;
  let unresolved = 0;
  let noOp = 0;
  let queryMissing = 0;
  const unresolvedByReason = { ZERO_RESULTS: 0, PARTIAL_MATCH: 0, TOO_FAR: 0 };

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const queries: (string | null)[] = batch.map((row) => buildBackfillGeocodingQuery(row, COUNTRY));

    const indexedQueries = queries
      .map((q, idx) => ({ q, idx }))
      .filter((x): x is { q: string; idx: number } => x.q !== null);

    queryMissing += batch.length - indexedQueries.length;
    if (indexedQueries.length === 0) continue;

    const results = await geocoder.geocodeBatch(
      indexedQueries.map((x) => x.q),
      COUNTRY,
      RATE_LIMIT_MS,
    );

    const client = isApply ? await pool.connect() : null;
    try {
      if (client) await client.query('BEGIN');

      for (let k = 0; k < results.length; k++) {
        const row = batch[indexedQueries[k].idx];
        const geocode = results[k];
        const reason = classifyBackfillUnresolved(row, geocode);

        if (reason !== null) {
          unresolved++;
          unresolvedByReason[reason]++;
          if (reason === 'PARTIAL_MATCH') {
            console.log(`  ⚠ PARTIAL_MATCH ${row.id} → raw="${indexedQueries[k].q.slice(0, 70)}" result="${geocode?.formattedAddress}" — needs manual review, not written`);
          } else if (reason === 'TOO_FAR') {
            const km = geocode ? haversineDistanceKm(row.lat as number, row.lng as number, geocode.latitude, geocode.longitude) : 0;
            console.log(`  ⚠ TOO_FAR (${km.toFixed(1)} km) ${row.id} → existing=(${row.lat}, ${row.lng}) result="${geocode?.formattedAddress}" (${geocode?.latitude}, ${geocode?.longitude}) — needs manual review, not written`);
          } else {
            console.log(`  ✗ ${row.id} → NO RESULT for "${indexedQueries[k].q.slice(0, 70)}"`);
          }
          continue;
        }

        const plan = buildBackfillPlan(row, geocode);
        if (!plan) {
          // Unreachable — classifyBackfillUnresolved above already covers every
          // null-plan case. Kept as a defensive guard against future drift.
          unresolved++;
          console.log(`  ✗ ${row.id} → NO RESULT for "${indexedQueries[k].q.slice(0, 70)}"`);
          continue;
        }

        if (plan.changes.length === 0) {
          noOp++;
          continue;
        }

        resolved++;
        for (const change of plan.changes) {
          console.log(`  ~ ${row.id} [${change.field}]: ${JSON.stringify(change.oldValue)} → ${JSON.stringify(change.newValue)}`);
        }

        if (client) {
          const setClauses: string[] = [];
          const values: unknown[] = [];
          let paramIdx = 1;
          for (const [field, value] of Object.entries(plan.updates)) {
            setClauses.push(`${field} = $${paramIdx}`);
            values.push(value);
            paramIdx++;
          }
          setClauses.push('updated_at = now()');
          values.push(plan.id);
          await client.query(
            `UPDATE patient_addresses SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
            values,
          );
        }
      }

      if (client) await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      console.error(`[backfill-address-location] batch ${i / BATCH_SIZE} failed:`, err);
      throw err;
    } finally {
      client?.release();
    }

    console.log(
      `[backfill-address-location] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(eligible.length / BATCH_SIZE)} done — resolved=${resolved} unresolved=${unresolved} noOp=${noOp} queryMissing=${queryMissing}`,
    );
  }

  console.log(
    `[backfill-address-location] DONE mode=${isApply ? 'APPLY' : 'DRY RUN'} — resolved=${resolved} unresolved=${unresolved} (zeroResults=${unresolvedByReason.ZERO_RESULTS} partialMatch=${unresolvedByReason.PARTIAL_MATCH} tooFar=${unresolvedByReason.TOO_FAR}) noOp=${noOp} queryMissing=${queryMissing} shellExcluded=${shellSkipped} manuallyExcluded=${manuallyExcluded.length}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill-address-location] FATAL:', err);
  process.exit(1);
});
