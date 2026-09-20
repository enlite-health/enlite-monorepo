/**
 * src/modules/anacare-hours/interfaces/controllers/AnaCareHoursSyncController.ts
 *
 * F4 (tasks 4.8/4.9) — DESENHO mínimo. Dois pontos de entrada chamam o MESMO
 * `AnaCareHoursSyncRunner` (instância compartilhada, guardada no módulo — o guard de dedup só
 * funciona se a instância for a MESMA entre a chamada manual e a do cron):
 *
 *   POST /api/admin/anacare-hours/sync   (staff, botão "Sincronizar agora")  → origin: 'manual'
 *   POST /api/internal/anacare-hours/sync (Cloud Scheduler / X-Internal-Secret) → origin: 'cron'
 *
 * Fail-closed: sem `ANACARE_HOURS_SOURCE` (`fake`|`real`), 503 `ANACARE_SOURCE_NOT_CONFIGURED`,
 * mesmo padrão do `AnaCareHoursController`. `createAnaCareSyncDependencies` decide fonte + diretório
 * + repositórios JUNTOS pela mesma env (F4 continuação, migration 439) — `'real'` chama o Ana Care
 * de verdade (por reserva, nunca varredura), `'fake'` é 100% em memória (dev/e2e local).
 */

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { createAnaCareSyncDependencies } from '../../infrastructure/AnaCareSyncDependenciesFactory';
import { AnaCarePatientMonthCollisionError } from '../../infrastructure/AnaCarePatientMonthRepository';
import { emitAnaCareHoursSyncMetric } from '../../infrastructure/AnaCareHoursSyncMetrics';
import { AnaCareHoursSyncRunner } from '../../application/AnaCareHoursSyncRunner';
import { syncTriggerBodySchema } from '../validators/anacareHoursSchemas';

export class AnaCareHoursSyncController {
  constructor(private readonly runnerFactory: () => AnaCareHoursSyncRunner | null = AnaCareHoursSyncController.defaultRunnerFactory) {}

  /**
   * Singleton no módulo: a MESMA instância de `AnaCareHoursSyncRunner` (e, portanto, o MESMO
   * `AnaCareHoursSyncGuard`) atende tanto a rota manual quanto a rota de cron — é o que faz o
   * dedup de disparo concorrente funcionar entre as duas entradas.
   */
  private static sharedRunner: AnaCareHoursSyncRunner | null | undefined;

  private static defaultRunnerFactory(): AnaCareHoursSyncRunner | null {
    if (AnaCareHoursSyncController.sharedRunner === undefined) {
      const deps = createAnaCareSyncDependencies();
      AnaCareHoursSyncController.sharedRunner = deps
        ? new AnaCareHoursSyncRunner(
            deps.source,
            undefined,
            undefined,
            undefined,
            deps.directory,
            deps.directorySnapshotRepository,
            undefined,
            deps.patientMonthRepository,
            deps.syncRunRepository,
          )
        : null;
    }
    return AnaCareHoursSyncController.sharedRunner;
  }

  /** Só para teste: força o próximo `defaultRunnerFactory()` a resolver de novo. */
  static resetSharedRunnerForTests(): void {
    AnaCareHoursSyncController.sharedRunner = undefined;
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  private async trigger(req: Request, res: Response, origin: 'manual' | 'cron'): Promise<void> {
    const body = syncTriggerBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const runner = this.runnerFactory();
    if (!runner) {
      res.status(503).json({ success: false, error: 'Ana Care source not configured', code: 'ANACARE_SOURCE_NOT_CONFIGURED' });
      return;
    }
    const startedAt = Date.now();
    try {
      const outcome = await runner.run({
        origin,
        userId: origin === 'manual' ? this.actorUid(req) : null,
        month: body.data.month,
        cursor: body.data.cursor,
        budgetMs: body.data.budgetMs,
      });
      res.status(200).json({
        success: true,
        deduped: outcome.deduped,
        shiftsRead: outcome.shiftsRead,
        reservationsProcessed: outcome.reservationsProcessed,
        shiftsWritten: outcome.shiftsWritten,
        nextCursor: outcome.nextCursor,
        // Gate `revisao-pr` (fecho 17/09): `runStartedAt` é o carimbo que o SERVIDOR resolveu
        // (migration 443) — sai só para OBSERVABILIDADE (script de medição loga, não reenvia). O
        // chamador reenvia `nextCursor` numa retomada; `runStartedAt` não é mais entrada da rota.
        runStartedAt: outcome.runStartedAt,
        shiftsSkippedNoProvider: outcome.shiftsSkippedNoProvider,
        shiftsSkippedNoPatient: outcome.shiftsSkippedNoPatient,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `AnaCareHoursSyncController.trigger.${origin}` });
      // TAREFA D (gate `revisao-pr`): o `throw` escapa ANTES do `emitMetric` do caminho feliz
      // (`AnaCareHoursSyncRunner.run`) — sem isto, o detector de colisão dispara e a métrica nunca
      // sai (contagem zero indistinguível de "nunca colidiu").
      emitAnaCareHoursSyncMetric({
        event: 'anacare_hours_sync',
        origin,
        userId: origin === 'manual' ? this.actorUid(req) : null,
        requests: 0,
        retries: 0,
        durationMs: Date.now() - startedAt,
        deduped: false,
        error: e.name,
      });
      if (e instanceof AnaCarePatientMonthCollisionError) {
        // Código de erro DEDICADO (não mais o "Internal error" genérico) — detector que dispara e
        // ninguém vê não é detector: 409 (conflito, nunca sobrescrito calado) + código nomeado.
        res.status(409).json({ success: false, error: e.message, code: 'ANACARE_PATIENT_MONTH_COLLISION' });
        return;
      }
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }

  /** Botão "Sincronizar agora" (staff, `/api/admin/anacare-hours/sync`). */
  async triggerManual(req: Request, res: Response): Promise<void> {
    await this.trigger(req, res, 'manual');
  }

  /** Cloud Scheduler (`/api/internal/anacare-hours/sync`). */
  async triggerCron(req: Request, res: Response): Promise<void> {
    await this.trigger(req, res, 'cron');
  }
}
