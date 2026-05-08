/**
 * import-patients-dry-run.ts
 *
 * Dry-run helpers for import-patients-from-clickup.ts.
 * Extracted to keep the main script within the 400-line limit.
 *
 * In dry-run mode the UseCase is never called (it would write to DB).
 * Instead, this module replicates the skip logic and classifies each task
 * as would-create / would-update based on a pre-fetched existingIds set.
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import type { ClickUpTask } from '../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { ClickUpPatientMapper } from '../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import {
  classifyMapperNullReason,
  formatPatientName,
} from '../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DryRunCounters {
  processed: number;
  skippedNoName: number;
  skippedSubtask: number;
  skippedMapper: number;
  wouldCreate: number;
  wouldUpdate: number;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

export async function checkExistingTaskIds(
  pool: Pool,
  taskIds: string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const { rows } = await pool.query<{ clickup_task_id: string }>(
    `SELECT clickup_task_id FROM patients WHERE clickup_task_id = ANY($1)`,
    [taskIds],
  );
  return new Set(rows.map(r => r.clickup_task_id));
}

// ── Per-task processor ────────────────────────────────────────────────────────

export function processDryRun(
  task: ClickUpTask,
  i: number,
  total: number,
  mapper: ClickUpPatientMapper,
  existingIds: Set<string>,
  counters: DryRunCounters,
  isVerbose: boolean,
): void {
  const num = `[${i + 1}/${total}]`;

  if (task.parent !== null) {
    counters.skippedSubtask++;
    return;
  }

  let input: ReturnType<ClickUpPatientMapper['map']>;
  try {
    input = mapper.map(task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ERROR  task=${task.id} msg=mapper threw: ${msg}`);
    return;
  }

  if (input === null) {
    const reason = classifyMapperNullReason(task);
    if (reason === 'SKIPPED_NO_PATIENT_NAME') {
      console.log(`  ${num} task=${task.id} status=${task.status.status} → SKIPPED (no patient name)`);
      counters.skippedNoName++;
    } else {
      console.log(`  ${num} task=${task.id} status=${task.status.status} → SKIPPED (mapper returned null)`);
      counters.skippedMapper++;
    }
    return;
  }

  counters.processed++;

  const nameStr  = formatPatientName(input.firstName, input.lastName);
  const isUpdate = existingIds.has(task.id);
  if (isUpdate) counters.wouldUpdate++; else counters.wouldCreate++;

  const action = existingIds.size > 0
    ? (isUpdate ? 'would UPDATE' : 'would CREATE')
    : 'would UPSERT';

  const depStr   = input.dependencyLevel  ?? 'null';
  const svcStr   = input.serviceType      ? `[${input.serviceType.join(',')}]` : '[]';
  const specStr  = input.clinicalSpecialty ?? 'null';
  const resp     = input.responsibles?.[0];
  const respName = resp
    ? [resp.firstName, resp.lastName].filter(Boolean).join(' ') || 'none'
    : 'none';

  console.log(`  ${num} task=${task.id} status=${task.status.status} → ${nameStr}`);
  console.log(`         ${action} (dependency=${depStr}, service_type=${svcStr}, specialty=${specStr}, responsible="${respName}")`);

  if (isVerbose) {
    console.log('         payload:', JSON.stringify(input, null, 2));
  }
}
