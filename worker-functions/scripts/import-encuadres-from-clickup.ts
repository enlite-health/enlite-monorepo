#!/usr/bin/env ts-node
/**
 * import-encuadres-from-clickup.ts
 *
 * Paginates the ClickUp list "Encuadres" (901318471648) and for each task:
 *   1. Maps worker identity + encuadre entries via ClickUpEncuadreMapper
 *   2. Upserts the worker once per task (fill-only: never overwrite non-null fields)
 *   3. For each entry with a case number, resolves job_posting candidates
 *   4. 1 candidate → upserts encuadre linked
 *      2+ candidates → upserts encuadre with job_posting_id=null + enqueues to encuadre_ambiguity_queue
 *      0 candidates → logs WARN, skips encuadre (import-vacancies must run first)
 * After all tasks: calls linkWorkersByPhone() once.
 * (syncToWorkerJobApplications removida em F6 2026-05-24 — pipeline reverso deprecado)
 *
 * ── Pre-requisites ────────────────────────────────────────────────────────────
 *   - CLICKUP_API_TOKEN set in environment
 *   - DATABASE_URL set (required in --live mode)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   set -a && source worker-functions/.env && set +a
 *   cd worker-functions
 *   npx ts-node -r tsconfig-paths/register scripts/import-encuadres-from-clickup.ts --dry-run --limit 3
 *   npx ts-node -r tsconfig-paths/register scripts/import-encuadres-from-clickup.ts --live
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────
 *   --dry-run          (default) logs what would happen; no DB writes
 *   --live             alias for --dry-run=false; persists to DB
 *   --limit N          process only the first N tasks
 *   --verbose          print full mapped payload per task
 *   --list-id <id>     ClickUp list ID (default: 901318471648 Encuadres)
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpEncuadreMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpEncuadreMapper';
import type { EncuadreMapperEntry } from '../src/modules/integration/infrastructure/clickup/ClickUpEncuadreMapper';
import { normalizePhoneAR } from '../src/shared/utils/phoneNormalization';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { CreateEncuadreDTO } from '../src/modules/matching/domain/Encuadre';
import { upsertWorkerFromEncuadre } from './encuadres-worker-upsert';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_LIST_ID  = '901318471648'; // Encuadres
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const SCRIPT_TAG       = '[import-encuadres-from-clickup]';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean { return argv.includes(name); }

function flagValue(name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

let isDryRun = true;
if (hasFlag('--live')) isDryRun = false;
const dryRunFlag = argv.find(a => a.startsWith('--dry-run='));
if (dryRunFlag) isDryRun = dryRunFlag.split('=')[1] !== 'false';

const limitRaw  = flagValue('--limit');
const limit     = limitRaw !== null ? parseInt(limitRaw, 10) : null;
const isVerbose = hasFlag('--verbose');
const listId    = flagValue('--list-id') ?? DEFAULT_LIST_ID;

// ── Env validation ─────────────────────────────────────────────────────────────

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
if (!CLICKUP_TOKEN) {
  console.error(`${SCRIPT_TAG} ERROR: CLICKUP_API_TOKEN is not set.`);
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!isDryRun && !process.env.DATABASE_URL) {
  console.error(`${SCRIPT_TAG} ERROR: DATABASE_URL is required in --live mode.`);
  process.exit(1);
}

// F6 (2026-05-24) guard — script é legado e em deprecação.
// Pipeline reverso encuadres → WJA está morto. Novos imports criam encuadres
// sem WJA correspondente — viram lixo invisível no Kanban.
// Override consciente para backfill manual aprovado pelo PO:
//   export I_UNDERSTAND_F6_DEPRECATION=true
// Ver TD-047 em docs/FOLLOWUPS.md e docs/features/worker-job-applications/README.md
if (!isDryRun && process.env.I_UNDERSTAND_F6_DEPRECATION !== 'true') {
  console.error(`
╔════════════════════════════════════════════════════════════════════╗
║ ⚠️  SCRIPT DEPRECADO em F6 (2026-05-24)                            ║
║                                                                    ║
║ import-encuadres-from-clickup.ts está em deprecação. Pipeline      ║
║ reverso encuadres → WJA foi removido (F6). Novos imports criam     ║
║ encuadres SEM WJA correspondente — viram LIXO invisível no Kanban  ║
║ (Kanban lê de worker_job_applications, não de encuadres).          ║
║                                                                    ║
║ Se você TEM CERTEZA que precisa rodar (backfill manual aprovado    ║
║ pelo PO + plano de mitigação dos órfãos), exporte:                 ║
║                                                                    ║
║   export I_UNDERSTAND_F6_DEPRECATION=true                          ║
║                                                                    ║
║ Caso contrário, NÃO RODAR. Investigar disparador via TD-047 em     ║
║ docs/FOLLOWUPS.md (checklist de gcloud/SSH/n8n).                   ║
╚════════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// ── ClickUp pagination ────────────────────────────────────────────────────────

interface TasksPage { tasks: ClickUpTask[]; last_page: boolean; }

async function fetchPage(page: number): Promise<TasksPage> {
  const url =
    `${CLICKUP_API_BASE}/list/${listId}/task` +
    `?page=${page}&archived=false&subtasks=false&include_closed=true`;
  const res = await fetch(url, { headers: { Authorization: CLICKUP_TOKEN as string } });
  if (!res.ok) {
    throw new Error(`ClickUp /task failed: HTTP ${res.status} ${res.statusText} (page ${page})`);
  }
  return (await res.json()) as TasksPage;
}

async function fetchAllTasks(): Promise<ClickUpTask[]> {
  console.log(`${SCRIPT_TAG} Fetching ClickUp list ${listId}...`);
  const all: ClickUpTask[] = [];
  let page = 0;
  while (true) {
    const { tasks, last_page } = await fetchPage(page);
    all.push(...tasks);
    console.log(`  page ${page}: +${tasks.length} tasks (total ${all.length})`);
    if (last_page || tasks.length === 0) break;
    page++;
  }
  return all;
}

// ── Job posting resolution ────────────────────────────────────────────────────

interface JobPostingCandidate { id: string; service_address_formatted: string | null; }

async function resolveJobPostingCandidates(
  pool: Pool,
  caseNumber: number,
): Promise<JobPostingCandidate[]> {
  const r = await pool.query<JobPostingCandidate>(
    `SELECT id, service_address_formatted
     FROM job_postings
     WHERE case_number = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [caseNumber],
  );
  return r.rows;
}

// ── Ambiguity queue upsert ────────────────────────────────────────────────────

async function insertAmbiguityQueue(
  pool: Pool,
  encuadreId: string,
  caseNumber: number,
  candidateIds: string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO encuadre_ambiguity_queue (encuadre_id, case_number, candidate_job_posting_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [encuadreId, caseNumber, candidateIds],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const allTasks = await fetchAllTasks();
  console.log(`Fetched ${allTasks.length} tasks.\n`);

  const tasksToProcess = limit !== null ? allTasks.slice(0, limit) : allTasks;
  const modeStr  = isDryRun ? 'dry-run=true' : 'live (DB writes enabled)';
  const limitStr = limit !== null ? `limit=${limit}` : 'no limit';
  console.log(`Processing with flags: ${modeStr} ${limitStr} list=${listId}\n`);

  // Build resolver + mapper (fetches field definitions from ClickUp once)
  const resolver = await ClickUpFieldResolver.fromList(listId, { token: CLICKUP_TOKEN });
  const mapper   = new ClickUpEncuadreMapper(resolver);

  // DB connections — lazy; dry-run tries optionally (not critical)
  let pool: Pool | null = null;
  let encService: KMSEncryptionService | null = null;
  let bidxService: BlindIndexService | null = null;
  let encuadreRepo: import('../src/modules/matching/infrastructure/EncuadreRepository').EncuadreRepository | null = null;

  if (!isDryRun) {
    pool         = new Pool({ connectionString: DATABASE_URL });
    encService   = new KMSEncryptionService();
    bidxService  = new BlindIndexService();
    const { EncuadreRepository } = await import('../src/modules/matching/infrastructure/EncuadreRepository');
    encuadreRepo = new EncuadreRepository();
  } else {
    try { pool = new Pool({ connectionString: DATABASE_URL }); } catch { /* no-op */ }
  }

  // Counters
  let skippedSubtask    = 0;
  let skippedNoIdent    = 0;
  let encuadreNoCaseNum = 0;
  let workersCreated    = 0;
  let workersUpdated    = 0;
  let encuadresCreated  = 0;
  let encuadresExisted  = 0;
  let encuadreSkipped   = 0;   // 0 job_postings for case_number
  let encuadreAmbiguous = 0;   // 2+ job_postings → ambiguity queue
  let errors            = 0;
  let processed         = 0;

  for (let i = 0; i < tasksToProcess.length; i++) {
    const task = tasksToProcess[i];
    const num  = `[${i + 1}/${tasksToProcess.length}]`;

    if (task.parent !== null) { skippedSubtask++; continue; }

    let entries: ReturnType<ClickUpEncuadreMapper['map']>;
    try {
      entries = mapper.map(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR  task=${task.id} mapper threw: ${msg}`);
      errors++;
      continue;
    }

    if (entries === null) {
      console.log(`  ${num} task=${task.id} status=${task.status.status} → SKIPPED (no email and no whatsapp)`);
      skippedNoIdent++;
      continue;
    }

    processed++;
    const wData = entries[0].worker;
    const normalizedPhone = wData.rawWhatsapp ? normalizePhoneAR(wData.rawWhatsapp) || null : null;

    if (isDryRun) {
      const hasNoCase = entries.length === 1 && entries[0].encuadre === null;
      if (hasNoCase) encuadreNoCaseNum++;

      const caseStr = hasNoCase
        ? 'caseNumbers=[] (no case in name — WARN)'
        : `caseNumbers=[${entries.map(e => e.encuadre!.caseNumber).join(', ')}]`;

      console.log(
        `  ${num} task=${task.id} status=${task.status.status} → would UPSERT` +
        ` worker(email=${wData.email ?? 'null'}, phone=${normalizedPhone ?? 'null'})` +
        ` ${caseStr}`,
      );
      if (isVerbose) {
        console.log('         payload:', JSON.stringify({ worker: wData, entries }, null, 2));
      }
      continue;
    }

    // Live mode
    try {
      // Upsert worker once per task
      const wResult = await upsertWorkerFromEncuadre(
        { ...wData, phone: normalizedPhone, clickupTaskId: task.id },
        pool!,
        encService!,
        bidxService!,
      );
      if (wResult.created) { workersCreated++; } else { workersUpdated++; }

      const wAction = wResult.created ? 'CREATED' : 'UPDATED';
      console.log(`  ${num} task=${task.id} → worker ${wAction} id=${wResult.id}`);

      // Process each encuadre entry (one per case number)
      for (const entry of entries) {
        if (entry.encuadre === null) {
          encuadreNoCaseNum++;
          console.log(
            `  WARN   task=${task.id} — no case number extractable from name;` +
            ` worker created but no encuadre`,
          );
          continue;
        }

        const { encuadre: eData } = entry;
        const candidates = await resolveJobPostingCandidates(pool!, eData.caseNumber);

        if (candidates.length === 0) {
          encuadreSkipped++;
          console.log(
            `  WARN   task=${task.id} case_number=${eData.caseNumber}` +
            ` — 0 job_postings found; import-vacancies must run first`,
          );
          continue;
        }

        // Determine job_posting_id
        const isAmbiguous    = candidates.length >= 2;
        const jobPostingId   = isAmbiguous ? null : candidates[0].id;
        if (isAmbiguous) encuadreAmbiguous++;

        const dto: CreateEncuadreDTO = {
          workerId:       wResult.id,
          jobPostingId,
          workerRawName:  eData.rawName,
          workerRawPhone: eData.rawPhone,
          workerEmail:    wData.email,
          resultado:      eData.resultado,
          importSourceAudit: eData.importSourceAudit,
          dedupHash:      eData.dedupHash,
        };

        const { encuadre: createdEncuadre, created: encCreated } = await encuadreRepo!.upsert(dto);
        if (encCreated) { encuadresCreated++; } else { encuadresExisted++; }

        // Enqueue ambiguous encuadres
        if (isAmbiguous) {
          await insertAmbiguityQueue(
            pool!,
            createdEncuadre.id,
            eData.caseNumber,
            candidates.map(c => c.id),
          );
        }

        const eAction = encCreated ? 'CREATED' : 'EXISTED';
        console.log(
          `       case=${eData.caseNumber} → encuadre ${eAction}` +
          ` job_posting_id=${jobPostingId ?? `null (ambiguous, ${candidates.length} candidates)`}` +
          ` resultado=${eData.resultado}`,
        );
        if (isVerbose) {
          console.log('         payload:', JSON.stringify(eData, null, 2));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR  task=${task.id} msg=${msg}`);
      if (err instanceof Error && err.stack) {
        console.log(`         stack: ${err.stack.split('\n').slice(0, 5).join(' | ')}`);
      }
      errors++;
    }
  }

  // Post-sync (live only) — ver "Pipelines de import legados" no CLAUDE.md
  if (!isDryRun && encuadreRepo) {
    try {
      const linked = await encuadreRepo.linkWorkersByPhone();
      console.log(`\nPost-sync: linkWorkersByPhone → ${linked} rows affected`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\nERROR linkWorkersByPhone: ${msg}`);
    }

    // F6 (2026-05-24): sync recorrente removida. WJAs são SSOT do funil — populadas via
    // webhook Talentum / matchmaking / self-service / drag manual. Pipeline reverso
    // encuadres → WJA está deprecado. Ver docs/features/worker-job-applications/README.md.
  }

  // Summary
  console.log('\nSummary:');
  console.log(`  Fetched:                               ${allTasks.length} tasks`);
  console.log(`  Processed:                             ${processed}${limit !== null ? ` (limit=${limit})` : ''}`);
  console.log(`  Skipped (subtask):                     ${skippedSubtask}`);
  console.log(`  Skipped (no email/phone):              ${skippedNoIdent}`);
  console.log(`  Tasks with no case in name (warn):     ${encuadreNoCaseNum}`);
  console.log(`  Encuadres skipped (0 job_postings):    ${encuadreSkipped}`);
  console.log(`  Encuadres queued (ambiguity 2+ vagas): ${encuadreAmbiguous}`);
  if (isDryRun) {
    console.log(`  Would upsert workers:                  ${processed}`);
  } else {
    console.log(`  Workers created:                       ${workersCreated}`);
    console.log(`  Workers updated:                       ${workersUpdated}`);
    console.log(`  Encuadres created:                     ${encuadresCreated}`);
    console.log(`  Encuadres already existed (idem):      ${encuadresExisted}`);
  }
  console.log(`  Errors:                                ${errors}`);
  console.log(`  Mode:                                  ${isDryRun ? 'DRY-RUN (no DB writes)' : 'LIVE (DB writes committed)'}`);

  if (pool) await pool.end();
  if (errors > 0 && !isDryRun) process.exit(1);
}

main().catch(err => {
  console.error(`${SCRIPT_TAG} Fatal error:`, err);
  process.exit(1);
});
