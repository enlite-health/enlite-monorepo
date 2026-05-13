/**
 * backfill-worker-names-from-encuadres.ts
 *
 * Popula workers.first_name_encrypted, last_name_encrypted e name_trgm_bidx
 * a partir de encuadres.worker_raw_name (primário) ou Firebase displayName (fallback).
 *
 * Motivo: em produção, 100% dos workers tinham first_name_encrypted = NULL,
 * impossibilitando busca por nome no painel admin. Workers cadastrados via
 * email/password no Firebase nunca tiveram displayName setado, então a única
 * fonte confiável é o worker_raw_name vindo dos encuadres importados.
 *
 * Fonte primária: encuadres.worker_raw_name mais recente por worker.
 * Fonte fallback: Firebase displayName (apenas pros workers sem encuadre
 *                 cujo auth_uid não é prefixo de import — auth_uids fake
 *                 nunca terão displayName real).
 *
 * Uso:
 *   ts-node scripts/backfill-worker-names-from-encuadres.ts                    # produção
 *   ts-node scripts/backfill-worker-names-from-encuadres.ts --dry-run          # só conta
 *   ts-node scripts/backfill-worker-names-from-encuadres.ts --batch-size 25    # custom
 *   ts-node scripts/backfill-worker-names-from-encuadres.ts --skip-firebase    # só encuadres
 *
 * Idempotente: workers com first_name_encrypted IS NOT NULL são pulados.
 * Saída: CSV em ./backfill-worker-names-unresolved.csv com workers sem nome.
 */

import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`
Usage: ts-node scripts/backfill-worker-names-from-encuadres.ts [options]

Options:
  --dry-run          Count eligible workers and estimate cost without writing.
  --batch-size N     Workers per DB round-trip (default 50, max 200).
  --skip-firebase    Only use encuadres source (skip Firebase fallback).
  --help             Print this message and exit.
  `);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const skipFirebase = args.includes('--skip-firebase');

const batchSizeIdx = args.indexOf('--batch-size');
const rawBatchSize =
  batchSizeIdx !== -1 && args[batchSizeIdx + 1]
    ? parseInt(args[batchSizeIdx + 1], 10)
    : 50;

if (isNaN(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > 200) {
  console.error('[backfill-names] --batch-size must be between 1 and 200');
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
  auth_uid: string | null;
  email: string | null;
  worker_raw_name: string | null;
}

interface Summary {
  processed: number;
  updatedFromEncuadres: number;
  updatedFromFirebase: number;
  unresolved: number;
  errors: number;
}

interface UnresolvedEntry {
  workerId: string;
  authUid: string | null;
  email: string | null;
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const IMPORT_PREFIXES = [
  'anacareimport_',
  'candidatoimport_',
  'pretalnimport_',
  'talentum_',
];

function isFakeAuthUid(authUid: string | null): boolean {
  if (!authUid) return true;
  return IMPORT_PREFIXES.some((p) => authUid.startsWith(p));
}

function splitName(raw: string | null): { firstName: string | null; lastName: string | null } {
  if (!raw) return { firstName: null, lastName: null };
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return { firstName: null, lastName: null };
  const tokens = cleaned.split(' ');
  if (tokens.length === 1) {
    return { firstName: tokens[0], lastName: null };
  }
  return {
    firstName: tokens[0],
    lastName: tokens.slice(1).join(' '),
  };
}

// Lazy Firebase Admin loading — script roda fora do server, evita custo de init
// quando --skip-firebase está ativo ou nenhum worker precisa do fallback.
let firebaseAdmin: typeof import('firebase-admin') | null = null;

async function loadFirebaseAdmin(): Promise<typeof import('firebase-admin')> {
  if (firebaseAdmin) return firebaseAdmin;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin') as typeof import('firebase-admin');

  if (admin.apps.length === 0) {
    const projectId =
      process.env.GCP_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      'enlite-prd';
    admin.initializeApp({ projectId });
  }

  firebaseAdmin = admin;
  return admin;
}

async function fetchFirebaseDisplayName(authUid: string): Promise<string | null> {
  try {
    const admin = await loadFirebaseAdmin();
    const user = await admin.auth().getUser(authUid);
    const displayName = user.displayName?.trim() || null;
    return displayName;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new KMSEncryptionService();
  const bidx = new BlindIndexService();

  const startMs = Date.now();

  console.log(
    `[backfill-names] mode=${dryRun ? 'DRY RUN' : 'EXECUTE'} batch-size=${BATCH_SIZE} skip-firebase=${skipFirebase}`,
  );

  // ── Dry-run: count only ────────────────────────────────────────────────────

  if (dryRun) {
    const counts = await pool.query<{
      eligible: string;
      with_encuadre: string;
      without_encuadre_real_auth: string;
      without_encuadre_fake_auth: string;
    }>(`
      WITH eligible AS (
        SELECT w.id, w.auth_uid
          FROM workers w
         WHERE w.first_name_encrypted IS NULL
           AND w.merged_into_id IS NULL
      ),
      enriched AS (
        SELECT
          e.id,
          e.auth_uid,
          (SELECT worker_raw_name
             FROM encuadres
            WHERE worker_id = e.id AND worker_raw_name IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1) AS raw_name
        FROM eligible e
      )
      SELECT
        COUNT(*)::text AS eligible,
        COUNT(*) FILTER (WHERE raw_name IS NOT NULL)::text AS with_encuadre,
        COUNT(*) FILTER (
          WHERE raw_name IS NULL
            AND auth_uid IS NOT NULL
            AND auth_uid NOT LIKE 'anacareimport_%'
            AND auth_uid NOT LIKE 'candidatoimport_%'
            AND auth_uid NOT LIKE 'pretalnimport_%'
            AND auth_uid NOT LIKE 'talentum_%'
        )::text AS without_encuadre_real_auth,
        COUNT(*) FILTER (
          WHERE raw_name IS NULL
            AND (auth_uid IS NULL
              OR auth_uid LIKE 'anacareimport_%'
              OR auth_uid LIKE 'candidatoimport_%'
              OR auth_uid LIKE 'pretalnimport_%'
              OR auth_uid LIKE 'talentum_%')
        )::text AS without_encuadre_fake_auth
      FROM enriched
    `);

    const c = counts.rows[0];
    console.log(`[backfill-names] eligible total                : ${c.eligible}`);
    console.log(`[backfill-names] via encuadres                 : ${c.with_encuadre}`);
    console.log(`[backfill-names] via firebase (real auth_uid)  : ${c.without_encuadre_real_auth}`);
    console.log(`[backfill-names] unresolvable (fake auth_uid)  : ${c.without_encuadre_fake_auth}`);
    console.log('[backfill-names] [DRY RUN — nenhuma escrita realizada]');

    await pool.end();
    return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  const summary: Summary = {
    processed: 0,
    updatedFromEncuadres: 0,
    updatedFromFirebase: 0,
    unresolved: 0,
    errors: 0,
  };
  const unresolvedList: UnresolvedEntry[] = [];
  // In-memory skip-list pra evitar loop infinito: workers que ficaram unresolved
  // ou que deram erro nesta execução são re-pulados nas próximas queries.
  const triedIds = new Set<string>();
  let batchNum = 0;

  while (true) {
    const triedArray = Array.from(triedIds);
    const { rows } = await pool.query<WorkerRow>(
      `
      SELECT
        w.id,
        w.auth_uid,
        w.email,
        (SELECT worker_raw_name
           FROM encuadres
          WHERE worker_id = w.id AND worker_raw_name IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1) AS worker_raw_name
      FROM workers w
      WHERE w.first_name_encrypted IS NULL
        AND w.merged_into_id IS NULL
        AND ($2::uuid[] IS NULL OR w.id <> ALL($2::uuid[]))
      ORDER BY w.created_at ASC
      LIMIT $1
      `,
      [BATCH_SIZE, triedArray.length > 0 ? triedArray : null],
    );

    if (rows.length === 0) break;

    batchNum++;

    for (const row of rows) {
      summary.processed++;

      try {
        let firstName: string | null = null;
        let lastName: string | null = null;
        let source: 'encuadres' | 'firebase' | null = null;

        // ── Source 1: encuadres.worker_raw_name ───────────────────────
        if (row.worker_raw_name) {
          const parsed = splitName(row.worker_raw_name);
          firstName = parsed.firstName;
          lastName = parsed.lastName;
          if (firstName) source = 'encuadres';
        }

        // ── Source 2: Firebase displayName (fallback) ─────────────────
        if (!source && !skipFirebase && !isFakeAuthUid(row.auth_uid)) {
          const displayName = await fetchFirebaseDisplayName(row.auth_uid!);
          if (displayName) {
            const parsed = splitName(displayName);
            firstName = parsed.firstName;
            lastName = parsed.lastName;
            if (firstName) source = 'firebase';
          }
        }

        if (!source || !firstName) {
          summary.unresolved++;
          triedIds.add(row.id);
          unresolvedList.push({
            workerId: row.id,
            authUid: row.auth_uid,
            email: row.email,
            reason: row.worker_raw_name
              ? 'raw_name parse failed'
              : isFakeAuthUid(row.auth_uid)
                ? 'no encuadre + fake auth_uid'
                : skipFirebase
                  ? 'no encuadre + firebase skipped'
                  : 'no encuadre + firebase displayName empty',
          });
          continue;
        }

        // ── Encrypt + trigram + UPDATE ────────────────────────────────
        const [firstNameEnc, lastNameEnc, bidxBuffers] = await Promise.all([
          kms.encrypt(firstName),
          lastName ? kms.encrypt(lastName) : Promise.resolve(null),
          bidx.generateNameTrigramBidx(firstName, lastName),
        ]);
        const bidxLiteral = bidx.serializeForPg(bidxBuffers);

        await pool.query(
          `UPDATE workers
              SET first_name_encrypted = $1,
                  last_name_encrypted = $2,
                  name_trgm_bidx = $3::bytea[],
                  updated_at = NOW()
            WHERE id = $4`,
          [firstNameEnc, lastNameEnc, bidxLiteral, row.id],
        );

        if (source === 'encuadres') summary.updatedFromEncuadres++;
        else summary.updatedFromFirebase++;

        const fullName = [firstName, lastName].filter(Boolean).join(' ');
        console.log(
          `[backfill-names] [${summary.processed}] ${row.id} (${source}): "${fullName}"`,
        );
      } catch (err) {
        console.error(
          `[backfill-names] ERROR worker ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
        triedIds.add(row.id);
        summary.errors++;
      }
    }

    console.log(
      `[backfill-names] batch ${batchNum} done — ` +
        `encuadres=${summary.updatedFromEncuadres} ` +
        `firebase=${summary.updatedFromFirebase} ` +
        `unresolved=${summary.unresolved} ` +
        `errors=${summary.errors}`,
    );

    // Rate limit guard: 1s entre batches respeita quotas KMS e Firebase Auth.
    if (rows.length === BATCH_SIZE) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // ── CSV de não-resolvidos ──────────────────────────────────────────────────

  if (unresolvedList.length > 0) {
    const csvPath = './backfill-worker-names-unresolved.csv';
    const header = 'worker_id,auth_uid,email,reason\n';
    const lines = unresolvedList.map(
      (e) =>
        `${e.workerId},"${e.authUid ?? ''}","${e.email ?? ''}","${e.reason}"`,
    );
    writeFileSync(csvPath, header + lines.join('\n') + '\n', 'utf8');
    console.log(`[backfill-names] CSV de unresolved gravado em ${csvPath}`);
  }

  const elapsedMs = Date.now() - startMs;

  console.log('\n[backfill-names] ── SUMMARY ──────────────────────────────');
  console.log(`  processed              : ${summary.processed}`);
  console.log(`  updated (encuadres)    : ${summary.updatedFromEncuadres}`);
  console.log(`  updated (firebase)     : ${summary.updatedFromFirebase}`);
  console.log(`  unresolved             : ${summary.unresolved}`);
  console.log(`  errors                 : ${summary.errors}`);
  console.log(`  elapsed                : ${(elapsedMs / 1000).toFixed(1)}s`);

  await pool.end();

  if (summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[backfill-names] FATAL:', err);
  process.exit(1);
});
