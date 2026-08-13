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
import { extractPatientChatIds } from '../infrastructure/clickup/ClickUpPatientMapper';
import type { PatientService } from '../../case/application/PatientService';
import { PatientChatIdsService } from '../../case/application/PatientChatIdsService';

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
  /**
   * Espelha os campos "Chat ID Familia"/"Chat ID Equipo" do ClickUp em
   * `patient_chat_ids` (task 86ak04ygu). Opcional só para injeção em teste —
   * quando ausente, o use case constrói o real. O passo inteiro fica atrás de
   * PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED.
   */
  chatIdsService?: PatientChatIdsService;
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
        correlationId:    cid,
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

      await this.syncChatIds(task, result.id, cid);

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

  /**
   * Espelha os grupos de WhatsApp do ClickUp em `patient_chat_ids`.
   *
   * Best-effort DEPOIS do upsert do paciente: um grupo em disputa (409) ou um
   * valor torto no ClickUp não pode derrubar a sincronização da ficha — por
   * isso os conflitos viram log estruturado, não exceção. Vazio no ClickUp
   * nunca desvincula (ver PatientChatIdsService.syncFromClickUp).
   */
  private async syncChatIds(task: ClickUpTask, patientId: string, cid: string): Promise<void> {
    if (process.env.PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED !== 'true') return;

    const { chatIds, invalid } = extractPatientChatIds(task);

    for (const bad of invalid) {
      functions.logger.warn('clickup_patient_sync.chat_id_invalid', {
        taskId: task.id,
        role:   bad.role,
        value:  bad.value,
        correlationId: cid,
      });
    }
    if (Object.keys(chatIds).length === 0) return;

    try {
      const service = this.deps.chatIdsService ?? new PatientChatIdsService();
      const outcome = await service.syncFromClickUp(patientId, chatIds);

      if (outcome.applied.length > 0 || outcome.skipped.length > 0) {
        functions.logger.info('clickup_patient_sync.chat_ids', {
          taskId: task.id,
          patientId,
          applied:   outcome.applied,
          unchanged: outcome.unchanged,
          skipped:   outcome.skipped,
          correlationId: cid,
        });
      }
    } catch (err) {
      // Falha de infraestrutura no passo de chat ids (banco fora etc.): loga e
      // segue — a ficha do paciente já foi gravada e o reconcile de 10min
      // reaplica os grupos no próximo ciclo.
      functions.logger.error('clickup_patient_sync.chat_ids_failed', {
        taskId: task.id,
        patientId,
        error: err instanceof Error ? err.message : String(err),
        correlationId: cid,
      });
    }
  }
}
