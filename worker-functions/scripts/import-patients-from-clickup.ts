#!/usr/bin/env ts-node
/**
 * import-patients-from-clickup.ts
 *
 * Paginates the ClickUp list "Estado de Pacientes" (901304883903) and upserts
 * each task as a patient via PatientService.upsertFromClickUp().
 *
 * ── Pre-requisites ────────────────────────────────────────────────────────────
 *   - CLICKUP_API_TOKEN set in environment
 *   - DATABASE_URL set (required in --live mode, optional in --dry-run)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   set -a && source worker-functions/.env && set +a
 *   cd worker-functions
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --dry-run --limit 3
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --live
 *   npx ts-node -r tsconfig-paths/register scripts/import-patients-from-clickup.ts --live --status busqueda --limit 10
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────
 *   --dry-run          (default) logs what would happen; no DB writes
 *   --live             alias for --dry-run=false; persists to DB
 *   --dry-run=false    same as --live
 *   --limit N          process only the first N tasks (default: all)
 *   --status X,Y,Z     filter tasks by status.status (comma-separated)
 *   --verbose          print the full PatientServiceUpsertInput per task
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { SyncPatientFromClickUpTaskUseCase } from '../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import { PatientSourceLabelRepository } from '../src/modules/case';
import {
  checkExistingTaskIds,
  processDryRun,
  type DryRunCounters,
} from './import-patients-dry-run';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIST_ID = '901304883903'; // Estado de Pacientes
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const SCRIPT_TAG = '[import-patients-from-clickup]';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function flagValue(name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

// --dry-run is default true; override with --live or --dry-run=false
let isDryRun = true;
if (hasFlag('--live')) isDryRun = false;
const dryRunFlag = argv.find(a => a.startsWith('--dry-run='));
if (dryRunFlag) {
  isDryRun = dryRunFlag.split('=')[1] !== 'false';
}

const limitRaw = flagValue('--limit');
const limit = limitRaw !== null ? parseInt(limitRaw, 10) : null;

const statusFilterRaw = flagValue('--status');
const statusFilter: string[] = statusFilterRaw
  ? statusFilterRaw.split(',').map(s => s.trim().toLowerCase())
  : [];

const isVerbose = hasFlag('--verbose');

// ── Env validation ─────────────────────────────────────────────────────────────

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
if (!CLICKUP_TOKEN) {
  console.error(`${SCRIPT_TAG} ERROR: CLICKUP_API_TOKEN is not set in environment.`);
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!isDryRun && !process.env.DATABASE_URL) {
  console.error(`${SCRIPT_TAG} ERROR: DATABASE_URL is required in --live mode.`);
  process.exit(1);
}

// ── ClickUp pagination ────────────────────────────────────────────────────────

interface TasksPage {
  tasks: ClickUpTask[];
  last_page: boolean;
}

async function fetchPage(page: number): Promise<TasksPage> {
  const url =
    `${CLICKUP_API_BASE}/list/${LIST_ID}/task` +
    `?page=${page}&archived=false&subtasks=false&include_closed=true`;

  const res = await fetch(url, {
    headers: { Authorization: CLICKUP_TOKEN as string },
  });

  if (!res.ok) {
    throw new Error(`ClickUp /task API failed: HTTP ${res.status} ${res.statusText} (page ${page})`);
  }

  return (await res.json()) as TasksPage;
}

async function fetchAllTasks(): Promise<ClickUpTask[]> {
  console.log(`${SCRIPT_TAG} Fetching ClickUp list ${LIST_ID}...`);
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Lazy-load PatientService (imports DatabaseConnection → needs DATABASE_URL).
  // Only in live mode; avoids a DB connection in pure dry-run.
  let useCase: SyncPatientFromClickUpTaskUseCase | null = null;
  let pool: Pool | null = null;

  if (!isDryRun) {
    const { PatientService } = await import('@modules/case');
    const patientService = new PatientService();
    const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN as string });
    const mapper = new ClickUpPatientMapper(resolver);
    useCase = new SyncPatientFromClickUpTaskUseCase({
      mapper, patientService,
      // Task 2.3 — o cru vai junto do derivado, também no caminho de recuperação manual.
      sourceLabelRepository: new PatientSourceLabelRepository(),
    });
    pool = new Pool({ connectionString: DATABASE_URL });
  }

  // For dry-run with DATABASE_URL available we can classify create vs update.
  let dryRunPool: Pool | null = null;
  let dryRunMapper: ClickUpPatientMapper | null = null;
  if (isDryRun) {
    try {
      dryRunPool = new Pool({ connectionString: DATABASE_URL });
    } catch {
      // Not critical — dry-run will report "would upsert" without classification
    }
    const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN as string });
    dryRunMapper = new ClickUpPatientMapper(resolver);
  }

  // Step 1: Fetch all tasks
  const allTasks = await fetchAllTasks();
  console.log(`Fetched ${allTasks.length} tasks.\n`);

  // Step 2: Apply status filter
  const filteredTasks = statusFilter.length > 0
    ? allTasks.filter(t => statusFilter.includes(t.status.status.toLowerCase()))
    : allTasks;

  // Step 3: Apply limit
  const tasksToProcess = limit !== null ? filteredTasks.slice(0, limit) : filteredTasks;

  const modeStr   = isDryRun ? 'dry-run=true' : 'live (DB writes enabled)';
  const limitStr  = limit !== null ? `limit=${limit}` : 'no limit';
  const statusStr = statusFilter.length > 0 ? `status=${statusFilter.join(',')}` : 'all statuses';
  console.log(`Processing with flags: ${modeStr} ${limitStr} ${statusStr}`);

  // Step 4: Pre-classify for dry-run (SELECT existing task IDs)
  let existingIds = new Set<string>();
  if (isDryRun && dryRunPool) {
    const taskIds = tasksToProcess.filter(t => t.parent === null).map(t => t.id);
    try {
      existingIds = await checkExistingTaskIds(dryRunPool, taskIds);
    } catch {
      // DB not reachable — skip classification
    }
  }

  // Step 5: Process tasks
  let processed = 0;
  let skippedNoName = 0;
  let skippedSubtask = 0;
  let skippedMapper = 0;
  let wouldCreate = 0;
  let wouldUpdate = 0;
  let created = 0;
  let updated = 0;
  let flaggedCreated = 0;
  let flaggedUpdated = 0;
  let caseNumberConflicts = 0;
  let errors = 0;

  for (let i = 0; i < tasksToProcess.length; i++) {
    const task = tasksToProcess[i];
    const num  = `[${i + 1}/${tasksToProcess.length}]`;

    if (isDryRun) {
      const counters: DryRunCounters = {
        processed, skippedNoName, skippedSubtask, skippedMapper, wouldCreate, wouldUpdate,
      };
      processDryRun(task, i, tasksToProcess.length, dryRunMapper!, existingIds, counters, isVerbose);
      ({ processed, skippedNoName, skippedSubtask, skippedMapper, wouldCreate, wouldUpdate } = counters);
      continue;
    }

    // Live mode — delegate entirely to the UseCase
    const result = await useCase!.execute(task);

    switch (result.kind) {
      case 'SKIPPED_SUBTASK':
        skippedSubtask++;
        break;

      case 'SKIPPED_NO_PATIENT_NAME':
        console.log(`  ${num} task=${result.taskId} → SKIPPED (no patient name)`);
        skippedNoName++;
        break;

      case 'SKIPPED_MAPPER_NULL':
        console.log(`  ${num} task=${result.taskId} → SKIPPED (mapper returned null)`);
        skippedMapper++;
        break;

      case 'ERROR':
        console.log(`  ERROR  task=${result.taskId} msg=${result.error.message}`);
        if (result.error.stack) {
          console.log(`         stack: ${result.error.stack.split('\n').slice(0, 5).join(' | ')}`);
        }
        errors++;
        break;

      case 'CASE_NUMBER_CONFLICT':
        processed++;
        caseNumberConflicts++;
        console.log(
          `  ${num} task=${result.taskId} case=${result.caseNumber ?? 'unknown'} → CONFLICT (patient persisted without case_number, needs_attention)`,
        );
        break;

      case 'CREATED':
        processed++;
        created++;
        if (result.flagged) flaggedCreated++;
        console.log(
          `  ${num} task=${result.taskId} → CREATED patient id=${result.patientId} (${result.patientName})${result.flagged ? ' [flagged]' : ''}`,
        );
        break;

      case 'UPDATED':
        processed++;
        updated++;
        if (result.flagged) flaggedUpdated++;
        console.log(
          `  ${num} task=${result.taskId} → UPDATED patient id=${result.patientId} (${result.patientName})${result.flagged ? ' [flagged]' : ''}`,
        );
        break;
    }
  }

  // Step 6: Summary
  const totalFetched = allTasks.length;
  const totalSkipped = skippedNoName + skippedSubtask + skippedMapper;

  console.log('\nSummary:');
  console.log(`  Fetched:       ${totalFetched} tasks`);
  if (statusFilter.length > 0) {
    console.log(`  After filter:  ${filteredTasks.length} tasks (status=${statusFilter.join(',')})`);
  }
  console.log(`  Processed:     ${processed}${limit !== null ? ` (limit=${limit})` : ''}`);
  console.log(`  Skipped:       ${totalSkipped} (${skippedNoName} no name, ${skippedSubtask} subtask, ${skippedMapper} mapper null)`);

  if (isDryRun) {
    if (existingIds.size > 0) {
      console.log(`  Would create:  ${wouldCreate}`);
      console.log(`  Would update:  ${wouldUpdate}`);
    } else {
      console.log(`  Would upsert:  ${processed} (DB not queried for classification)`);
    }
  } else {
    console.log(`  Created:       ${created}`);
    console.log(`  Updated:       ${updated}`);
    const totalFlagged = flaggedCreated + flaggedUpdated;
    if (totalFlagged > 0) {
      console.log(`  Flagged:       ${totalFlagged} (needs_attention=true, reason=MISSING_INFO)`);
    }
    if (caseNumberConflicts > 0) {
      console.log(`  Conflicts:     ${caseNumberConflicts} (case_number duplicate — persisted with case_number=null, needs_attention=CASE_NUMBER_CONFLICT)`);
    }
  }

  console.log(`  Errors:        ${errors}`);
  console.log(`  Mode:          ${isDryRun ? 'DRY-RUN (no DB writes)' : 'LIVE (DB writes committed)'}`);

  // Cleanup
  if (pool) await pool.end();
  if (dryRunPool) await dryRunPool.end();

  const fs = await import('fs');
  const probePath = '/tmp/clickup-fields-probe.json';
  if (fs.existsSync(probePath)) fs.unlinkSync(probePath);

  if (errors > 0 && !isDryRun) process.exit(1);
}

main().catch(err => {
  console.error(`${SCRIPT_TAG} Fatal error:`, err);
  process.exit(1);
});
