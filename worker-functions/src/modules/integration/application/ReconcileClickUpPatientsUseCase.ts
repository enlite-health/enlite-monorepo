/**
 * ReconcileClickUpPatientsUseCase
 *
 * Rede de segurança da sincronização ClickUp→Enlite de pacientes.
 *
 * A sincronização normal é 100% webhook (task-a-task) e é rápida, mas tem dois
 * pontos cegos ESTRUTURAIS:
 *
 *   1. Evento perdido → ninguém nunca mais olha aquele card.
 *      → modo `incremental`: pergunta ao ClickUp o que mudou na janela.
 *
 *   2. O problema de um card depende de OUTRO card → o webhook nunca é avisado.
 *      Foi o incidente do caso 601 (23/07): dois cards disputando o mesmo
 *      "Caso Número"; o perdedor é gravado com case_number=NULL (CASE_NUMBER_CONFLICT)
 *      e some do seletor de vacantes. Quando o humano resolve o conflito no ClickUp,
 *      quem muda é o card RIVAL — o card travado não gera evento nenhum.
 *      → modo `orphans`: parte do estado do BANCO, não do ClickUp. É o único
 *        que encontra essa vítima.
 *
 * Todo modo termina em SyncPatientFromClickUpTaskUseCase — o mesmo caminho que o
 * webhook usa — para que reconciliação e webhook nunca divirjam de comportamento.
 */

import * as functions from 'firebase-functions';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { ClickUpTaskListGateway } from '../infrastructure/clickup/ClickUpTaskListGateway';
import type { ClickUpTask } from '../infrastructure/clickup/ClickUpTask';
import type { SyncPatientFromClickUpTaskUseCase } from './SyncPatientFromClickUpTaskUseCase';

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** `cycle` (default do scheduler) = incremental + orphans na mesma execução. */
export type ReconcileMode = 'cycle' | 'incremental' | 'orphans' | 'full';

export interface ReconcileCounters {
  mode: ReconcileMode;
  windowMinutes: number | null;
  fetched: number;
  processed: number;
  created: number;
  updated: number;
  conflicts: number;
  errors: number;
  skipped: { subtask: number; noName: number; mapperNull: number; otherList: number };
  durationMs: number;
}

export type ReconcileOutcome =
  | { kind: 'BUSY' }
  | { kind: 'DONE'; counters: ReconcileCounters };

export interface ReconcileOptions {
  mode?: ReconcileMode;
  windowMinutes?: number;
  now?: () => number;
}

export interface ReconcileDeps {
  gateway: ClickUpTaskListGateway;
  syncUseCase: SyncPatientFromClickUpTaskUseCase;
  pool?: Pool;
}

// ── Constantes ────────────────────────────────────────────────────────────────

/**
 * Chave fixa do advisory lock. Precisa ser a MESMA em todas as instâncias do
 * Cloud Run — é o que impede duas execuções do cron de se atropelarem.
 */
const ADVISORY_LOCK_KEY = 86010723;

const DEFAULT_WINDOW_MINUTES = 30;

/**
 * Teto de órfãos por execução. Hoje são ~6. Se passar disso, o problema é de
 * DADO (duplicatas em massa no ClickUp) e martelar a API não resolve — o log
 * avisa em vez de varrer indefinidamente.
 */
const MAX_ORPHANS_PER_RUN = 200;

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyCounters(mode: ReconcileMode, windowMinutes: number | null): ReconcileCounters {
  return {
    mode,
    windowMinutes,
    fetched: 0,
    processed: 0,
    created: 0,
    updated: 0,
    conflicts: 0,
    errors: 0,
    skipped: { subtask: 0, noName: 0, mapperNull: 0, otherList: 0 },
    durationMs: 0,
  };
}

// ── Use case ──────────────────────────────────────────────────────────────────

export class ReconcileClickUpPatientsUseCase {
  private readonly pool: Pool;

  constructor(private readonly deps: ReconcileDeps) {
    this.pool = deps.pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(opts: ReconcileOptions = {}): Promise<ReconcileOutcome> {
    const mode = opts.mode ?? 'cycle';
    const windowMinutes = opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
    const now = opts.now ?? (() => Date.now());
    const cid = shortId();
    const startMs = now();

    const usesWindow = mode === 'cycle' || mode === 'incremental';
    const counters = emptyCounters(mode, usesWindow ? windowMinutes : null);

    // Advisory lock: precisa ser adquirido e liberado no MESMO client da pool.
    const client = await this.pool.connect();
    try {
      const lockRes = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ADVISORY_LOCK_KEY],
      );
      if (!lockRes.rows[0]?.locked) {
        functions.logger.info('reconcile.busy', { mode, correlationId: cid });
        return { kind: 'BUSY' };
      }

      try {
        functions.logger.info('reconcile.start', {
          mode,
          windowMinutes: counters.windowMinutes,
          correlationId: cid,
        });

        if (mode === 'cycle' || mode === 'incremental') {
          const since = now() - windowMinutes * 60_000;
          const tasks = await this.deps.gateway.fetchUpdatedSince(since);
          counters.fetched += tasks.length;
          await this.processTasks(tasks, counters, cid);
        }

        if (mode === 'cycle' || mode === 'orphans') {
          const tasks = await this.fetchOrphanTasks(counters, cid);
          counters.fetched += tasks.length;
          await this.processTasks(tasks, counters, cid);
        }

        if (mode === 'full') {
          const tasks = await this.deps.gateway.fetchAll();
          counters.fetched += tasks.length;
          await this.processTasks(tasks, counters, cid);
        }

        counters.durationMs = now() - startMs;

        functions.logger.info('reconcile.completed', { ...counters, correlationId: cid });
        return { kind: 'DONE', counters };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Órfãos = vítimas de CASE_NUMBER_CONFLICT: ativos no ClickUp mas sem número
   * no banco, portanto invisíveis no seletor de nova vacante.
   */
  private async fetchOrphanTasks(counters: ReconcileCounters, cid: string): Promise<ClickUpTask[]> {
    const { rows } = await this.pool.query<{ clickup_task_id: string }>(
      `SELECT clickup_task_id
         FROM patients
        WHERE case_number IS NULL
          AND needs_attention = true
          AND deleted_at IS NULL
          AND clickup_task_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT $1`,
      [MAX_ORPHANS_PER_RUN + 1],
    );

    if (rows.length > MAX_ORPHANS_PER_RUN) {
      functions.logger.warn('reconcile.orphans_over_cap', {
        cap: MAX_ORPHANS_PER_RUN,
        correlationId: cid,
      });
    }

    const ids = rows.slice(0, MAX_ORPHANS_PER_RUN).map(r => r.clickup_task_id);
    functions.logger.info('reconcile.orphans_found', { count: ids.length, correlationId: cid });

    const tasks: ClickUpTask[] = [];
    for (const taskId of ids) {
      try {
        const task = await this.deps.gateway.fetchById(taskId);
        if (task === null) {
          counters.skipped.otherList++;
          continue;
        }
        tasks.push(task);
      } catch (err) {
        counters.errors++;
        functions.logger.error('reconcile.orphan_fetch_failed', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
          correlationId: cid,
        });
      }
    }
    return tasks;
  }

  /**
   * Processa sequencialmente. Uma task que falha NÃO aborta as demais — a
   * reconciliação é rede de segurança; parar tudo por um card ruim seria o
   * oposto do objetivo.
   */
  private async processTasks(
    tasks: ClickUpTask[],
    counters: ReconcileCounters,
    cid: string,
  ): Promise<void> {
    for (const task of tasks) {
      try {
        const result = await this.deps.syncUseCase.execute(task, { onMissingContact: 'flag' }, cid);

        switch (result.kind) {
          case 'CREATED':
            counters.processed++;
            counters.created++;
            break;
          case 'UPDATED':
            counters.processed++;
            counters.updated++;
            break;
          case 'CASE_NUMBER_CONFLICT':
            // Esperado enquanto o humano não desduplicar no ClickUp. Não é erro.
            counters.processed++;
            counters.conflicts++;
            break;
          case 'SKIPPED_SUBTASK':
            counters.skipped.subtask++;
            break;
          case 'SKIPPED_NO_PATIENT_NAME':
            counters.skipped.noName++;
            break;
          case 'SKIPPED_MAPPER_NULL':
            counters.skipped.mapperNull++;
            break;
          case 'ERROR':
            counters.errors++;
            break;
        }
      } catch (err) {
        counters.errors++;
        functions.logger.error('reconcile.task_failed', {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
          correlationId: cid,
        });
      }
    }
  }
}
