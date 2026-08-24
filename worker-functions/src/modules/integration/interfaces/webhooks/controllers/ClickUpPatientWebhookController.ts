/**
 * ClickUpPatientWebhookController
 *
 * Receives ClickUp webhook events and syncs the corresponding patient record.
 *
 * Six filtering layers before any DB write:
 *   1. HMAC-SHA256 — verified by ClickUpHmacMiddleware before this controller runs.
 *   2. Body schema — Zod parse; must have event / webhook_id / task_id.
 *   3. list_id in payload — quick skip when the event is not for our patient list.
 *   4. GET task from ClickUp API — re-fetch to get full field set.
 *   5. task.list.id — confirms the fully-fetched task belongs to the patient list.
 *   6. catalog freshness (task 1.13) — the task is fresh, the field catalog is a boot-time
 *      photo. If the task disagrees with the photo, re-read the catalog before mapping; if
 *      the re-read fails, refuse to write rather than derive nulls from a stale catalog.
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
import { ClickUpPatientMapper, PATIENT_DROPDOWN_FIELDS } from '../../../infrastructure/clickup/ClickUpPatientMapper';
import { PatientSourceLabelRepository } from '@modules/case';
import {
  ClickUpCatalogRefresher,
  unsettledDriftThatMatters,
} from '../../../infrastructure/clickup/helpers/catalogRefresher';
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
    // Task 1.13: `resolver`/`mapper` are no longer fixed for the life of the process. The
    // catalog behind them is a PHOTO taken at boot, and `catalog` is what re-takes it when
    // the live task says the photo is stale. They are swapped together, never apart.
    private resolver: ClickUpFieldResolver,
    private mapper: ClickUpPatientMapper,
    private readonly patientService: PatientService,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    /**
     * Task 1.13. Optional on purpose: a controller built WITHOUT it behaves exactly as
     * before (single boot-time snapshot, no reload), which is what every pre-1.13 test
     * constructs. `create()` — the only thing production runs — always passes one.
     */
    private readonly catalog?: ClickUpCatalogRefresher,
    /**
     * Task 2.3 — onde o rótulo CRU é persistido.
     *
     * ⚠️ PREGUIÇOSO de propósito, e isto foi MEDIDO, não previsto. A 1ª versão era um default
     * de parâmetro (`= new PatientSourceLabelRepository()`), copiando o padrão do `db` acima.
     * O construtor do repositório chama `DatabaseConnection.getInstance()`, que LANÇA sem
     * `DATABASE_URL` — e default de parâmetro é avaliado na CONSTRUÇÃO, não no uso. Resultado:
     * 19 testes de 2 suítes quebraram, todos em caminhos que nem chegam a sincronizar (o
     * fail-closed de catálogo da 1.13 responde e volta antes). Construir na PRIMEIRA
     * ESCRITA mantém quem não escreve sem banco nenhum.
     */
    private sourceLabelRepository?: PatientSourceLabelRepository,
  ) {}

  /** O repositório do cru, construído na primeira vez que alguém realmente vai gravar. */
  private getSourceLabelRepository(): PatientSourceLabelRepository {
    this.sourceLabelRepository ??= new PatientSourceLabelRepository();
    return this.sourceLabelRepository;
  }

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
    // Task 1.13: the SAME loader that took the boot photo is handed to the refresher, so a
    // reload is the identical read against the identical list — not a second code path that
    // could drift from this one.
    const load           = (signal?: AbortSignal) =>
      ClickUpFieldResolver.fromList(PATIENT_LIST_ID, { token, signal });
    const resolver       = await load();
    const mapper         = new ClickUpPatientMapper(resolver);
    const patientService = new PatientService();
    const catalog        = new ClickUpCatalogRefresher(resolver, {
      declaredFields: PATIENT_DROPDOWN_FIELDS,
      load,
    });
    return new ClickUpPatientWebhookController(token, resolver, mapper, patientService, undefined, catalog);
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
      // Guard (migration 251): only ever soft-delete patients that came FROM
      // ClickUp. Native patients (origin != 'clickup') have clickup_task_id
      // NULL so they can never match this WHERE anyway, but the explicit
      // `AND origin = 'clickup'` is defense-in-depth against a future ClickUp
      // task id colliding with a native row — Enlite is the source of truth
      // for native patients and ClickUp must never delete them.
      const result = await this.db.query(
        "UPDATE patients SET deleted_at = NOW() WHERE clickup_task_id = $1 AND origin = 'clickup' AND deleted_at IS NULL RETURNING id",
        [body.task_id],
      );
      const affected = result.rowCount ?? 0;

      // C-B do parecer do `lex` (24/08): o soft delete TEM de alcançar as tabelas de rótulo
      // cru. O `ON DELETE CASCADE` das FKs nunca dispara, porque não existe hard delete de
      // paciente no código vivo — e não existe por DECISÃO (ata 2026-07-22a#REQ-04, "nunca
      // apagar cadastro"). Sem esta chamada, o rótulo clínico literal fica pendurado num
      // paciente que a origem já removeu, em duas tabelas que nenhuma rotina de supressão
      // conhece. Ley 25.326, art. 4º incs. 5 e 7.
      //
      // Falha aqui NÃO derruba o soft delete: o paciente já está marcado, e reverter isso
      // seria pior. Mas grita com evento próprio — supressão que falha calada é o F43 outra vez.
      let purgados = { labels: 0, rejections: 0 };
      for (const row of result.rows as Array<{ id: string }>) {
        try {
          const r = await this.getSourceLabelRepository().purgeForPatient(row.id);
          purgados = { labels: purgados.labels + r.labels, rejections: purgados.rejections + r.rejections };
        } catch (err) {
          functions.logger.error('clickup_webhook.source_labels_purge_failed', {
            correlationId, taskId: body.task_id, patientId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      functions.logger.info('clickup_webhook.task_deleted', {
        correlationId,
        taskId:      body.task_id,
        affectedRows: affected,
        rotulosCrusSuprimidos:  purgados.labels,
        recusasSuprimidas:      purgados.rejections,
      });
      res.status(200).json({ success: true, action: 'soft_deleted', affectedRows: affected });
      return;
    }

    // ── Layer 4: GET full task from ClickUp ───────────────────────────────────
    let task: ClickUpTask;
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

    // ── Layer 6 (task 1.13): is the field CATALOG as fresh as this task? ─────
    // The task above came fresh from the API; the catalog behind `this.mapper` is a photo
    // taken at boot. If they disagree, the 1.11 preflight would be checking the rename
    // against a photo where the field still exists — passing, and letting a "could not
    // read" null be written over stored data. Re-read the catalog before deciding.
    if (this.catalog) {
      const refresh = await this.catalog.ensureFreshFor(task.custom_fields);

      if (refresh.reloaded) {
        this.resolver = this.catalog.resolver;
        this.mapper   = new ClickUpPatientMapper(this.resolver);
        // C1/lex: field names and types only — schema metadata. No value, no task id.
        functions.logger.warn('clickup_webhook.catalog_reloaded', {
          correlationId,
          driftBefore: refresh.drift.items,
          driftAfter:  refresh.driftAfterReload.items,
        });
      }

      // Fail closed: we KNOW the snapshot is stale and we could NOT refresh it. Mapping now
      // would derive nulls from a catalog we already distrust, and the write path has no
      // COALESCE (D-E) — it would erase. Nothing is written; the refusal is loud.
      //
      // Task 1.13b — but only when it MATTERS, and "matters" is asked of the mapper, never of
      // which signal fired. The 1.12 harvester replays the reads for THIS task, so the answer
      // is the set of names the code just asked for: a field nobody reads cannot stop the
      // sync, and a field the mapper does read cannot be waved through because its signal
      // happened to be the "noisy" one. Both directions were measured broken by the QA.
      //
      // The probe runs ONLY here — the failed-reload branch — so the happy path pays nothing.
      const reloadIsSuspect =
        refresh.outcome === 'reload_failed' || refresh.outcome === 'suppressed_after_failure';
      const impact = reloadIsSuspect
        ? unsettledDriftThatMatters(
            refresh,
            this.catalog.resolver,
            task.custom_fields,
            this.mapper.fieldNamesReadFor(task),
          )
        : [];
      if (impact.length > 0) {
        functions.logger.error('clickup_webhook.catalog_stale', {
          correlationId,
          outcome: refresh.outcome,
          drift:   refresh.drift.items,
          // C1/lex: field name + kind + types. No value, no orderindex, no task id.
          impact,
        });
        res.status(200).json({ success: false, action: 'catalog_stale' });
        return;
      }
    }

    // ── Sync via UseCase (layer 5 / parent check is inside UseCase) ──────────
    const useCase = new SyncPatientFromClickUpTaskUseCase({
      mapper:         this.mapper,
      patientService: this.patientService,
      // Task 2.3 — o cru vai junto do derivado. O repositório abre a própria conexão do pool
      // compartilhado; não há transação do controller para carregar aqui.
      sourceLabelRepository: this.getSourceLabelRepository(),
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
