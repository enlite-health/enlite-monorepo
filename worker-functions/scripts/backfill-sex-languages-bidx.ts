/**
 * backfill-sex-languages-bidx.ts
 *
 * Backfill das colunas sex_bidx e languages_bidx em workers existentes.
 * Decripta sex_encrypted e languages_encrypted via KMS, normaliza, gera bidx,
 * atualiza cada row.
 *
 * CANONICAL VALUE:
 *   sex_bidx       → HMAC de normalizeSexValue(decrypted_sex): 'male' | 'female'
 *   languages_bidx → HMAC de cada language em lowercase via normalizeSearch
 *
 * Uso:
 *   ts-node scripts/backfill-sex-languages-bidx.ts                 # produção
 *   ts-node scripts/backfill-sex-languages-bidx.ts --dry-run       # só conta
 *   ts-node scripts/backfill-sex-languages-bidx.ts --batch-size 25 # custom batch
 *
 * Idempotente: workers onde sex_bidx IS NOT NULL E languages_bidx IS NOT NULL
 *   (ou ambos são nulos porque não há dado criptografado) são pulados.
 * Workers com merged_into_id IS NOT NULL são pulados.
 *
 * NÃO execute em produção sem validar --dry-run primeiro.
 */

import { Pool } from 'pg';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';
import { normalizeSexValue } from '../src/shared/utils/normalizeSexValue';

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`
Usage: ts-node scripts/backfill-sex-languages-bidx.ts [options]

Options:
  --dry-run          Count eligible workers without writing.
  --batch-size N     Workers per DB round-trip (default 50, max 200).
  --help             Print this message and exit.
  `);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');

const batchSizeIdx = args.indexOf('--batch-size');
const rawBatchSize =
  batchSizeIdx !== -1 && args[batchSizeIdx + 1]
    ? parseInt(args[batchSizeIdx + 1], 10)
    : 50;

if (isNaN(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > 200) {
  console.error('[backfill-sex-languages-bidx] --batch-size must be between 1 and 200');
  process.exit(1);
}

const BATCH_SIZE = rawBatchSize;

// ── DB setup ───────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkerRow {
  id: string;
  sex_encrypted: string | null;
  languages_encrypted: string | null;
}

interface Summary {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new KMSEncryptionService();
  const bidxService = new BlindIndexService();

  const startMs = Date.now();

  console.log(
    `[backfill-sex-languages-bidx] mode=${dryRun ? 'DRY RUN' : 'EXECUTE'} batch-size=${BATCH_SIZE}`,
  );

  // ── Dry-run: count only ────────────────────────────────────────────────────

  if (dryRun) {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM workers
        WHERE (sex_bidx IS NULL OR languages_bidx IS NULL)
          AND merged_into_id IS NULL
          AND (sex_encrypted IS NOT NULL OR languages_encrypted IS NOT NULL)`,
    );
    const total = parseInt(rows[0].total, 10);
    const batches = Math.ceil(total / BATCH_SIZE);

    console.log(`[backfill-sex-languages-bidx] eligible workers : ${total}`);
    console.log(`[backfill-sex-languages-bidx] batches          : ${batches}`);
    console.log('[backfill-sex-languages-bidx] [DRY RUN — nenhuma escrita realizada]');

    await pool.end();
    return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  const summary: Summary = { processed: 0, updated: 0, skipped: 0, errors: 0 };
  const triedIds = new Set<string>();
  let batchNum = 0;

  while (true) {
    const triedArray = Array.from(triedIds);
    const { rows } = await pool.query<WorkerRow>(
      `SELECT id, sex_encrypted, languages_encrypted
         FROM workers
        WHERE (sex_bidx IS NULL OR languages_bidx IS NULL)
          AND merged_into_id IS NULL
          AND (sex_encrypted IS NOT NULL OR languages_encrypted IS NOT NULL)
          AND ($2::uuid[] IS NULL OR id <> ALL($2::uuid[]))
        ORDER BY created_at ASC
        LIMIT $1`,
      [BATCH_SIZE, triedArray.length > 0 ? triedArray : null],
    );

    if (rows.length === 0) break;

    batchNum++;

    for (const row of rows) {
      summary.processed++;

      try {
        // Decrypt sex and languages in parallel
        const [rawSex, rawLanguages] = await Promise.all([
          kms.decrypt(row.sex_encrypted),
          kms.decrypt(row.languages_encrypted),
        ]);

        // Generate sex_bidx using normalizeSexValue (SAME as write-path)
        const canonicalSex = normalizeSexValue(rawSex);
        const sexBidxBuffer = await bidxService.generateValueBidx(canonicalSex);

        // Generate languages_bidx
        let languages: string[] = [];
        if (rawLanguages) {
          try {
            const parsed = JSON.parse(rawLanguages);
            if (Array.isArray(parsed)) {
              languages = parsed.filter((l: unknown) => typeof l === 'string');
            } else if (typeof parsed === 'string') {
              languages = [parsed];
            }
          } catch {
            // Not JSON — treat as single language string
            languages = [rawLanguages];
          }
        }
        const languagesBidxBuffers = await bidxService.generateValuesBidx(languages);
        const languagesBidxLiteral = bidxService.serializeForPg(languagesBidxBuffers);

        if (sexBidxBuffer === null && languagesBidxLiteral === null) {
          console.warn(
            `[backfill-sex-languages-bidx] WARN worker ${row.id}: no usable bidx after decrypt — skipping`,
          );
          triedIds.add(row.id);
          summary.skipped++;
          continue;
        }

        await pool.query(
          `UPDATE workers
              SET sex_bidx = $2,
                  languages_bidx = $3::bytea[]
            WHERE id = $1`,
          [row.id, sexBidxBuffer, languagesBidxLiteral],
        );

        console.log(
          `[backfill-sex-languages-bidx] [${summary.processed}] worker ${row.id}: sex=${canonicalSex ?? 'null'} langs=${languages.length}`,
        );

        summary.updated++;
      } catch (err) {
        console.error(
          `[backfill-sex-languages-bidx] ERROR worker ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
        triedIds.add(row.id);
        summary.errors++;
      }
    }

    console.log(
      `[backfill-sex-languages-bidx] batch ${batchNum} done — ` +
        `updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors}`,
    );

    // KMS rate limit guard: 1s sleep between batches
    if (rows.length === BATCH_SIZE) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const elapsedMs = Date.now() - startMs;

  console.log('\n[backfill-sex-languages-bidx] ── SUMMARY ──────────────────────────────');
  console.log(`  processed : ${summary.processed}`);
  console.log(`  updated   : ${summary.updated}`);
  console.log(`  skipped   : ${summary.skipped}`);
  console.log(`  errors    : ${summary.errors}`);
  console.log(`  elapsed   : ${(elapsedMs / 1000).toFixed(1)}s`);

  await pool.end();

  if (summary.errors > 0) {
    process.exit(1);
  }

  // KMSEncryptionService instancia um client gRPC (KeyManagementServiceClient)
  // cujo canal mantém o event loop vivo mesmo após pool.end(). Sem exit explícito
  // o processo "trava" após concluir o trabalho. Saída limpa no sucesso:
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-sex-languages-bidx] FATAL:', err);
  process.exit(1);
});
