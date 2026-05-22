/**
 * ClickUpPatientWebhookController
 *
 * Receives ClickUp webhook events and syncs the corresponding patient record.
 *
 * Five filtering layers before any DB write:
 *   1. HMAC-SHA256 — verified by ClickUpHmacMiddleware before this controller runs.
 *   2. Body schema — Zod parse; must have event / webhook_id / task_id.
 *   3. list_id in payload — quick skip when the event is not for our patient list.
 *   4. GET task from ClickUp API — re-fetch to get full field set.
 *   5. task.list.id — confirms the fully-fetched task belongs to the patient list.
 *
 * taskDeleted is handled without a GET (soft-delete by clickup_task_id).
 * All other events invoke SyncPatientFromClickUpTaskUseCase.
 */

import { Request, Response } from 'express';
import * as functions from 'firebase-functions';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { ClickUpWebhookBodySchema } from '../validators/clickupWebhookSchema';
import { SyncPatientFromClickUpTaskUseCase } from '../../../application/SyncPatientFromClickUpTaskUseCase';
import { ClickUpFieldResolver } from '../../../infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../../infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../../../infrastructure/clickup/ClickUpTask';
import { PatientService } from '../../../../case/application/PatientService';

const PATIENT_LIST_ID  = '901304883903';
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

function generateCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class ClickUpPatientWebhookController {
  constructor(
    private readonly clickupApiToken: string,
    private readonly resolver: ClickUpFieldResolver,
    private readonly mapper: ClickUpPatientMapper,
    private readonly patientService: PatientService,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /**
   * Liveness probe (no auth — only exposes structural state, no PII or counters).
   * Use in Cloud Monitoring uptime checks; does NOT validate ClickUp connectivity.
   */
  health(_req: Request, res: Response): void {
    res.status(200).json({
      status: 'ok',
      service: 'clickup-patient-webhook',
      patientListId: PATIENT_LIST_ID,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  static async create(): Promise<ClickUpPatientWebhookController> {
    const token = process.env.CLICKUP_API_TOKEN;
    if (!token) throw new Error('CLICKUP_API_TOKEN missing');
    const resolver      = await ClickUpFieldResolver.fromList(PATIENT_LIST_ID, { token });
    const mapper        = new ClickUpPatientMapper(resolver);
    const patientService = new PatientService();
    return new ClickUpPatientWebhookController(token, resolver, mapper, patientService);
  }

  async handle(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();

    // ── Layer 1: HMAC already verified by ClickUpHmacMiddleware ──────────────

    // ── Layer 2: body schema ──────────────────────────────────────────────────
    const parseResult = ClickUpWebhookBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      functions.logger.warn('clickup_webhook.invalid_body', {
        correlationId,
        errors: parseResult.error.issues,
      });
      res.status(400).json({ success: false, error: 'invalid body schema' });
      return;
    }
    const body = parseResult.data;

    functions.logger.info('clickup_webhook.received', {
      correlationId,
      event:  body.event,
      taskId: body.task_id,
      listId: body.list_id,
    });

    // ── Layer 3: list_id filter (quick skip before fetching task) ─────────────
    if (body.list_id && body.list_id !== PATIENT_LIST_ID) {
      functions.logger.info('clickup_webhook.skip_other_list', {
        correlationId,
        listId: body.list_id,
      });
      res.status(200).json({ success: true, action: 'skipped_other_list' });
      return;
    }

    // ── taskDeleted: soft-delete without fetching full task ───────────────────
    if (body.event === 'taskDeleted') {
      const result = await this.db.query(
        'UPDATE patients SET deleted_at = NOW() WHERE clickup_task_id = $1 AND deleted_at IS NULL RETURNING id',
        [body.task_id],
      );
      const affected = result.rowCount ?? 0;
      functions.logger.info('clickup_webhook.task_deleted', {
        correlationId,
        taskId:      body.task_id,
        affectedRows: affected,
      });
      res.status(200).json({ success: true, action: 'soft_deleted', affectedRows: affected });
      return;
    }

    // ── Layer 4: GET full task from ClickUp (or use injected task in test mode) ─
    let task: ClickUpTask;

    // _injectedTask: test-only bypass to avoid real ClickUp API calls in E2E.
    // Only honoured when NODE_ENV=test; silently ignored in production.
    const injected = process.env.NODE_ENV === 'test' ? body._injectedTask : undefined;
    if (injected && typeof injected === 'object') {
      task = injected as ClickUpTask;
      functions.logger.info('clickup_webhook.injected_task', { correlationId, taskId: body.task_id });
    } else {
      try {
        task = await this.fetchTask(body.task_id);
      } catch (err) {
        functions.logger.error('clickup_webhook.fetch_task_failed', {
          correlationId,
          taskId: body.task_id,
          error:  err instanceof Error ? err.message : String(err),
        });
        // Return 200 to avoid ClickUp retry storms; logged as error for investigation.
        res.status(200).json({ success: false, action: 'fetch_failed' });
        return;
      }
    }

    // ── Layer 5: confirm fetched task is in patient list ──────────────────────
    if (task.list?.id !== PATIENT_LIST_ID) {
      functions.logger.info('clickup_webhook.skip_task_other_list', {
        correlationId,
        taskId:       body.task_id,
        actualListId: task.list?.id,
      });
      res.status(200).json({ success: true, action: 'skipped_task_other_list' });
      return;
    }

    // ── Sync via UseCase (layer 5 / parent check is inside UseCase) ──────────
    const useCase = new SyncPatientFromClickUpTaskUseCase({
      mapper:         this.mapper,
      patientService: this.patientService,
    });
    const syncResult = await useCase.execute(task, { onMissingContact: 'flag' }, correlationId);

    res.status(200).json({
      success: true,
      action:  'synced',
      result:  { kind: syncResult.kind, taskId: syncResult.taskId },
    });
  }

  private async fetchTask(taskId: string): Promise<ClickUpTask> {
    const url      = `${CLICKUP_API_BASE}/task/${taskId}`;
    const response = await fetch(url, {
      headers: { Authorization: this.clickupApiToken },
    });
    if (!response.ok) {
      throw new Error(`ClickUp /task API ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as ClickUpTask;
  }
}
