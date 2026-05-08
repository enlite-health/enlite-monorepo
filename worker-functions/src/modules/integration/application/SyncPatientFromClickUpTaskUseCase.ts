/**
 * SyncPatientFromClickUpTaskUseCase
 *
 * Processes a single ClickUp task and upserts the corresponding patient record.
 * Designed to be called by both the batch CLI script and the incoming webhook handler.
 *
 * Does NOT fetch from the ClickUp API — the caller is responsible for fetching
 * and passing in an already-retrieved ClickUpTask.
 */

import * as functions from 'firebase-functions';
import type { ClickUpTask } from '../infrastructure/clickup/ClickUpTask';
import type { ClickUpPatientMapper } from '../infrastructure/clickup/ClickUpPatientMapper';
import type { PatientService } from '../../case/application/PatientService';

// ── Result types ──────────────────────────────────────────────────────────────

export type SyncPatientResult =
  | { kind: 'CREATED'; patientId: string; flagged: boolean; taskId: string; patientName: string }
  | { kind: 'UPDATED'; patientId: string; flagged: boolean; taskId: string; patientName: string }
  | { kind: 'CASE_NUMBER_CONFLICT'; patientId: string; taskId: string; caseNumber: number | null; patientName: string }
  | { kind: 'SKIPPED_SUBTASK'; taskId: string }
  | { kind: 'SKIPPED_NO_PATIENT_NAME'; taskId: string }
  | { kind: 'SKIPPED_MAPPER_NULL'; taskId: string }
  | { kind: 'ERROR'; taskId: string; error: Error };

export interface SyncPatientDeps {
  mapper: ClickUpPatientMapper;
  patientService: PatientService;
}

export interface SyncPatientOptions {
  onMissingContact?: 'flag' | 'error';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Formats first + last name into "Apellido, Nombre" display string.
 * Handles partial names (either component can be empty).
 */
export function formatPatientName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const last  = lastName  ?? '';
  const first = firstName ?? '';
  return `${last}, ${first}`.trim().replace(/^,\s*/, '').replace(/,\s*$/, '');
}

/**
 * Determines the reason a mapper returned null for a task that does have some data.
 * Used to distinguish between "truly empty task" vs "task with data mapper couldn't handle".
 */
export function classifyMapperNullReason(task: ClickUpTask): 'SKIPPED_NO_PATIENT_NAME' | 'SKIPPED_MAPPER_NULL' {
  const hasFirstName = task.custom_fields.some(
    f => f.name === 'Nombre de Paciente' && f.value,
  );
  const hasLastName = task.custom_fields.some(
    f => f.name === 'Apellido del Paciente' && f.value,
  );
  return (!hasFirstName && !hasLastName) ? 'SKIPPED_NO_PATIENT_NAME' : 'SKIPPED_MAPPER_NULL';
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ── Use case ──────────────────────────────────────────────────────────────────

export class SyncPatientFromClickUpTaskUseCase {
  constructor(private readonly deps: SyncPatientDeps) {}

  async execute(
    task: ClickUpTask,
    opts: SyncPatientOptions = {},
    correlationId?: string,
  ): Promise<SyncPatientResult> {
    const cid     = correlationId ?? shortId();
    const taskId  = task.id;
    const startMs = Date.now();

    functions.logger.info('clickup_patient_sync.start', {
      taskId,
      taskStatus: task.status?.status,
      correlationId: cid,
    });

    // Subtasks are skipped — the API already excludes them (subtasks=false),
    // but tasks can still carry a parent reference in edge cases.
    if (task.parent !== null) {
      functions.logger.warn('clickup_patient_sync.skipped', {
        taskId,
        kind: 'SKIPPED_SUBTASK',
        reason: 'task has parent',
        correlationId: cid,
      });
      return { kind: 'SKIPPED_SUBTASK', taskId };
    }

    // Attempt mapping
    let input: ReturnType<ClickUpPatientMapper['map']>;
    try {
      input = this.deps.mapper.map(task);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      functions.logger.error('clickup_patient_sync.error', {
        taskId,
        error: error.message,
        stack: error.stack,
        correlationId: cid,
      });
      return { kind: 'ERROR', taskId, error };
    }

    if (input === null) {
      const kind = classifyMapperNullReason(task);
      functions.logger.warn('clickup_patient_sync.skipped', {
        taskId,
        kind,
        reason: kind === 'SKIPPED_NO_PATIENT_NAME' ? 'no patient name in custom fields' : 'mapper returned null',
        correlationId: cid,
      });
      return { kind, taskId };
    }

    // Live upsert
    try {
      const result = await this.deps.patientService.upsertFromClickUp(input, {
        onMissingContact: opts.onMissingContact ?? 'flag',
      });

      const patientName = formatPatientName(input.firstName, input.lastName);

      if (result.conflict === 'CASE_NUMBER_CONFLICT') {
        functions.logger.warn('clickup_patient_sync.case_number_conflict', {
          taskId,
          caseNumber: input.caseNumber ?? null,
          patientId:  result.id,
          durationMs: Date.now() - startMs,
          correlationId: cid,
          // PII: patientName not logged here
        });
        return {
          kind:        'CASE_NUMBER_CONFLICT',
          patientId:   result.id,
          taskId,
          caseNumber:  input.caseNumber ?? null,
          patientName,
        };
      }

      const kind: 'CREATED' | 'UPDATED' = result.created ? 'CREATED' : 'UPDATED';

      // PII: não logar patientName aqui — vai pro Cloud Logging.
      // patientName fica apenas no SyncPatientResult retornado pro CLI script.
      functions.logger.info('clickup_patient_sync.completed', {
        taskId,
        kind,
        patientId:     result.id,
        flagged:       result.flagged,
        durationMs:    Date.now() - startMs,
        correlationId: cid,
      });

      return { kind, patientId: result.id, flagged: result.flagged, taskId, patientName };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      functions.logger.error('clickup_patient_sync.error', {
        taskId,
        error: error.message,
        stack: error.stack,
        durationMs: Date.now() - startMs,
        correlationId: cid,
      });
      return { kind: 'ERROR', taskId, error };
    }
  }
}
