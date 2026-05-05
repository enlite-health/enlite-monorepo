#!/usr/bin/env ts-node
/**
 * import-vacancies-from-clickup.ts
 *
 * Paginates the ClickUp list "Estado de Pacientes" (901304883903) and upserts
 * each task as one or more job_postings via JobPostingARRepository.upsertFromClickUp().
 *
 * Pre-conditions:
 *   1. import-patients-from-clickup.ts must have run first (patients.clickup_task_id needed).
 *   2. CLICKUP_API_TOKEN set in environment.
 *   3. DATABASE_URL set (required in --live mode).
 *
 * Usage:
 *   set -a && source worker-functions/.env && set +a
 *   cd worker-functions
 *   npx ts-node -r tsconfig-paths/register scripts/import-vacancies-from-clickup.ts --dry-run --limit 5 --verbose
 *   npx ts-node -r tsconfig-paths/register scripts/import-vacancies-from-clickup.ts --live
 *
 * Flags:
 *   --dry-run          (default) logs what would happen; no DB writes
 *   --live             alias for --dry-run=false; persists to DB
 *   --dry-run=false    same as --live
 *   --limit N          process only the first N tasks (default: all)
 *   --verbose          print the full VacancyUpsertInput per task
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpVacancyMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpVacancyMapper';
import { JobPostingARRepository } from '../src/modules/matching/infrastructure/JobPostingARRepository';
import { ShortLinkService } from '../src/modules/matching/infrastructure/shortlinks/ShortLinkService';
import { EnsureVacancyShortLinkUseCase } from '../src/modules/matching/application/EnsureVacancyShortLinkUseCase';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIST_ID = '901304883903'; // Estado de Pacientes
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const SCRIPT_TAG = '[import-vacancies-from-clickup]';

/** Statuses that require a public site short-link to exist. */
const PUBLIC_STATUSES = new Set(['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE']);

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

let isDryRun = true;
if (hasFlag('--live')) isDryRun = false;
const dryRunFlag = argv.find(a => a.startsWith('--dry-run='));
if (dryRunFlag) {
  isDryRun = dryRunFlag.split('=')[1] !== 'false';
}

const limitRaw = flagValue('--limit');
const limit = limitRaw !== null ? parseInt(limitRaw, 10) : null;

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

// ── Patient ID resolution ─────────────────────────────────────────────────────

async function resolvePatientId(
  pool: Pool,
  clickupTaskId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM patients WHERE clickup_task_id = $1 LIMIT 1`,
    [clickupTaskId],
  );
  return rows[0]?.id ?? null;
}

// ── Patient status cascade ────────────────────────────────────────────────────

async function updatePatientStatus(
  pool: Pool,
  patientId: string,
  patientStatus: string,
): Promise<void> {
  // Fill-only: só popula se o paciente ainda não tem status definido.
  // Isso preserva estados clínicos que admin tenha marcado manualmente
  // (ex: SUSPENDED por incidente interno que ClickUp não reflete).
  await pool.query(
    `UPDATE patients SET status = COALESCE(status, $1), updated_at = NOW() WHERE id = $2`,
    [patientStatus, patientId],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let pool: Pool | null = null;
  let jobRepo: JobPostingARRepository | null = null;
  let shortLinkUseCase: EnsureVacancyShortLinkUseCase | null = null;

  if (!isDryRun) {
    pool = new Pool({ connectionString: DATABASE_URL });
    jobRepo = new JobPostingARRepository();

    // Short.io — optional; silently skip if env vars are absent
    const shortLinkService = ShortLinkService.fromEnv();
    if (shortLinkService) {
      shortLinkUseCase = new EnsureVacancyShortLinkUseCase(pool, shortLinkService);
    } else {
      console.warn(`${SCRIPT_TAG} WARN: SHORT_IO_API_KEY / SHORT_IO_DOMAIN not set — site short-links will not be generated.`);
    }
  }

  // Dry-run: we still open a pool for classification queries if DATABASE_URL is reachable
  let dryRunPool: Pool | null = null;
  if (isDryRun) {
    try {
      dryRunPool = new Pool({ connectionString: DATABASE_URL });
    } catch {
      // Not critical in dry-run
    }
  }

  const effectivePool = pool ?? dryRunPool;

  // Step 1: Fetch all tasks
  const allTasks = await fetchAllTasks();
  console.log(`Fetched ${allTasks.length} tasks.\n`);

  // Step 2: Apply limit
  const tasksToProcess = limit !== null ? allTasks.slice(0, limit) : allTasks;

  const modeStr  = isDryRun ? 'dry-run=true' : 'live (DB writes enabled)';
  const limitStr = limit !== null ? `limit=${limit}` : 'no limit';
  console.log(`Processing with flags: ${modeStr} ${limitStr}`);

  // Step 3: Build resolver + mapper (resolver is only needed for future enrichment;
  // ClickUpVacancyMapper does not use ClickUpFieldResolver — fields are text/number/location).
  // We still call fromList to validate the token and ensure connectivity.
  await ClickUpFieldResolver.fromList(LIST_ID, { token: CLICKUP_TOKEN });
  const mapper = new ClickUpVacancyMapper();

  // ── Counters ────────────────────────────────────────────────────────────────
  let tasksFetched       = allTasks.length;
  let skippedSubtask     = 0;
  let skippedNoCaseNum   = 0;
  let skippedNoPatient   = 0;
  let vacanciesCreated   = 0;
  let vacanciesUpdated   = 0;
  let patientsNoMatch    = 0;
  let patientsStatusUpdated = 0;
  let errors             = 0;

  // Step 4: Process tasks
  for (let i = 0; i < tasksToProcess.length; i++) {
    const task = tasksToProcess[i];
    const num  = `[${i + 1}/${tasksToProcess.length}]`;

    // Defensive subtask filter
    if (task.parent !== null) {
      skippedSubtask++;
      continue;
    }

    // Map task → list of VacancyUpsertInput
    const inputs = mapper.map(task);

    if (inputs.length === 0) {
      // mapper returns [] only for subtasks (handled above) or no case_number
      skippedNoCaseNum++;
      console.log(`  ${num} task=${task.id} → SKIPPED (no Caso Número)`);
      continue;
    }

    // Resolve patient_id from patients table
    let patientId: string | null = null;
    if (effectivePool) {
      try {
        patientId = await resolvePatientId(effectivePool, task.id);
      } catch {
        // DB not reachable in dry-run, continue without classification
      }
    }

    if (patientId === null) {
      patientsNoMatch++;
      skippedNoPatient++;
      console.warn(
        `  ${num} task=${task.id} caseNumber=${inputs[0].caseNumber}` +
        ` → WARN: patient not found (clickup_task_id=${task.id}). Run import-patients first. SKIPPED.`,
      );
      continue;
    }

    // Cascade patient status — all inputs for the same task share the same patientStatus
    const patientStatus = inputs[0].patientStatus;

    if (isDryRun) {
      if (patientStatus) {
        console.log(
          `  ${num} task=${task.id}` +
          ` → would UPDATE patient.status=${patientStatus} (patient=${patientId})`,
        );
      }
    } else if (patientStatus && pool) {
      try {
        await updatePatientStatus(pool, patientId, patientStatus);
        patientsStatusUpdated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ERROR  task=${task.id} updating patient status: ${msg}`);
        errors++;
      }
    }

    // Process input — one job_posting per task (address now lives in patient_addresses)
    for (const input of inputs) {
      if (isDryRun) {
        console.log(
          `  ${num} task=${task.id} caseNumber=${input.caseNumber}` +
          ` → would UPSERT vacancy (patient=${patientId}, status=${input.jobPostingStatus})`,
        );

        if (isVerbose) {
          console.log('         payload:', JSON.stringify({ ...input, patientId }, null, 2));
        }
      } else {
        try {
          // upsertFromClickUp calls upsertClickUpSync internally, which uses
          // ON CONFLICT (job_posting_id) — safe because PRIMARY KEY on job_posting_id is unique.
          const result = await jobRepo!.upsertFromClickUp({
            caseNumber:               input.caseNumber,
            clickupTaskId:            input.clickupTaskId,
            status:                   input.jobPostingStatus,
            workerProfileSought:      input.workerProfileSought,
            scheduleDaysHours:        input.scheduleDaysHours,
            dueDate:                  input.dueDate,
            searchStartDate:          input.searchStartDate,
            patientId,
            sourceCreatedAt:          new Date(parseInt(task.date_created)),
            sourceUpdatedAt:          new Date(parseInt(task.date_updated)),
          });

          if (result.created) {
            vacanciesCreated++;
            console.log(
              `  ${num} task=${task.id} → CREATED vacancy id=${result.id}` +
              ` (caseNumber=${input.caseNumber})`,
            );
          } else {
            vacanciesUpdated++;
            console.log(
              `  ${num} task=${task.id} → UPDATED vacancy id=${result.id}` +
              ` (caseNumber=${input.caseNumber})`,
            );
          }

          // After a successful upsert, ensure site short-link exists for public statuses.
          // Non-blocking: if Short.io is unavailable, log a warning and continue.
          if (shortLinkUseCase && input.jobPostingStatus && PUBLIC_STATUSES.has(input.jobPostingStatus)) {
            try {
              const linkResult = await shortLinkUseCase.execute(result.id, 'site');
              if (!linkResult.alreadyExisted) {
                console.log(
                  `  ${num} task=${task.id} → SHORT LINK created for vacancy ${result.id}` +
                  ` → ${linkResult.shortURL}`,
                );
              }
            } catch (linkErr) {
              const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
              console.warn(
                `  ${num} WARN task=${task.id} vacancy=${result.id}` +
                ` site short-link failed (non-fatal): ${linkMsg}`,
              );
            }
          }

          if (isVerbose) {
            console.log('         payload:', JSON.stringify({ ...input, patientId }, null, 2));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `  ERROR  task=${task.id} caseNumber=${input.caseNumber} msg=${msg}`,
          );
          errors++;
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const tasksProcessed =
    tasksToProcess.length - skippedSubtask - skippedNoCaseNum - skippedNoPatient;

  console.log('\nSummary:');
  console.log(`  Tasks fetched:       ${tasksFetched}`);
  if (limit !== null) {
    console.log(`  Tasks limit:         ${limit}`);
  }
  console.log(`  Skipped (subtask):   ${skippedSubtask}`);
  console.log(`  Skipped (no case#):  ${skippedNoCaseNum}`);
  console.log(`  Skipped (no patient):${skippedNoPatient}`);
  console.log(`  Tasks processed:     ${tasksProcessed}`);

  if (isDryRun) {
    console.log(`  Mode:                DRY-RUN (no DB writes)`);
  } else {
    console.log(`  Patient statuses updated: ${patientsStatusUpdated}`);
    console.log(`  Vacancies created:   ${vacanciesCreated}`);
    console.log(`  Vacancies updated:   ${vacanciesUpdated}`);
    console.log(`  Errors:              ${errors}`);
    console.log(`  Mode:                LIVE (DB writes committed)`);
  }

  if (patientsNoMatch > 0) {
    console.warn(
      `\n  WARN: ${patientsNoMatch} task(s) had no matching patient.` +
      ` Run import-patients-from-clickup.ts first.`,
    );
  }

  // Cleanup
  if (pool) await pool.end();
  if (dryRunPool) await dryRunPool.end();

  if (errors > 0 && !isDryRun) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`${SCRIPT_TAG} Fatal error:`, err);
  process.exit(1);
});
