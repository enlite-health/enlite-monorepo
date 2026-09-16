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
 * Nenhuma chamada real ao Ana Care — fonte é `FakeAnaCareShiftsSource` (fail-closed: sem
 * `ANACARE_HOURS_SOURCE=fake`, 503 `ANACARE_SOURCE_NOT_CONFIGURED`, mesmo padrão do
 * `AnaCareHoursController`). O limitador de carga real (D341), upsert do retrato e FK por vínculo
 * (F3) são 4.1-4.7 — fora desta rodada.
 */

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { createAnaCareShiftsSource } from '../../infrastructure/FakeAnaCareShiftsSource';
import { AnaCareHoursSyncRunner } from '../../application/AnaCareHoursSyncRunner';

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
      const source = createAnaCareShiftsSource();
      AnaCareHoursSyncController.sharedRunner = source ? new AnaCareHoursSyncRunner(source) : null;
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
    const runner = this.runnerFactory();
    if (!runner) {
      res.status(503).json({ success: false, error: 'Ana Care source not configured', code: 'ANACARE_SOURCE_NOT_CONFIGURED' });
      return;
    }
    try {
      const outcome = await runner.run({ origin, userId: origin === 'manual' ? this.actorUid(req) : null });
      res.status(200).json({ success: true, deduped: outcome.deduped, shiftsRead: outcome.shiftsRead });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `AnaCareHoursSyncController.trigger.${origin}` });
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
