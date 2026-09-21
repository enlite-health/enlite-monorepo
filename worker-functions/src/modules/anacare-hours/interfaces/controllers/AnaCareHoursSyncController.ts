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
 *
 * F1 (migration 457, change `anacare-horas-conclusao-de-corrida`, 20/09/2026): a cada rodada, o
 * CONTROLLER (nunca o runner) grava o progresso em `anacare_sync_run` — `running` com
 * cursor/contagens quando a rodada corta por orçamento de tempo, `done` quando a lista de reservas
 * termina, `failed` (com `toStableErrorCode`, nunca `.message`) se o runner lançar. Falha ao
 * GRAVAR o progresso NUNCA derruba o sync (a missão é sincronizar; o registro é observabilidade) —
 * mas também não falha em silêncio: vai para `reportError` como qualquer outra exceção deste
 * controller. `syncRunRepositoryFactory` reusa a MESMA `SyncRunRepository` do runner compartilhado
 * (`sharedDeps`, abaixo) — nunca uma segunda instância/conexão.
 */

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { createAnaCareSyncDependencies, type AnaCareSyncDependencies } from '../../infrastructure/AnaCareSyncDependenciesFactory';
import { AnaCarePatientMonthCollisionError } from '../../infrastructure/AnaCarePatientMonthRepository';
import { toStableErrorCode } from '../../infrastructure/AnaCareSyncErrorCode';
import { emitAnaCareHoursSyncMetric } from '../../infrastructure/AnaCareHoursSyncMetrics';
import { AnaCareHoursSyncRunner } from '../../application/AnaCareHoursSyncRunner';
import type { SyncRunProgress, SyncRunRepository } from '../../domain/AnaCareHoursSyncPorts';
import { syncTriggerBodySchema } from '../validators/anacareHoursSchemas';

/** `anacare_sync_run.source` — mesma constante que o runner usa em `resolveRunStartedAt('anacare', ...)`. */
const SYNC_SOURCE = 'anacare';

export class AnaCareHoursSyncController {
  constructor(
    private readonly runnerFactory: () => AnaCareHoursSyncRunner | null = AnaCareHoursSyncController.defaultRunnerFactory,
    /**
     * F1 (migration 457): quem grava o progresso é o CONTROLLER. Default reusa a MESMA
     * `SyncRunRepository` do runner compartilhado (`resolveSharedDeps`) — nunca uma segunda
     * instância/conexão.
     */
    private readonly syncRunRepositoryFactory: () => SyncRunRepository | null = AnaCareHoursSyncController.defaultSyncRunRepositoryFactory,
  ) {}

  /**
   * Singleton no módulo: a MESMA instância de `AnaCareHoursSyncRunner` (e, portanto, o MESMO
   * `AnaCareHoursSyncGuard`) atende tanto a rota manual quanto a rota de cron — é o que faz o
   * dedup de disparo concorrente funcionar entre as duas entradas.
   */
  private static sharedRunner: AnaCareHoursSyncRunner | null | undefined;
  /**
   * F1 (migration 457): as dependências (`createAnaCareSyncDependencies()`) agora são cacheadas
   * UMA vez aqui — antes só o runner cacheava, e um acesso avulso a `syncRunRepository` teria que
   * rechamar a factory (risco de divergir do repositório que o runner já usa, se a env mudasse
   * entre as duas chamadas). `sharedRunner` e o repositório de progresso vêm sempre do MESMO
   * `sharedDeps`.
   */
  private static sharedDeps: AnaCareSyncDependencies | null | undefined;

  private static resolveSharedDeps(): AnaCareSyncDependencies | null {
    if (AnaCareHoursSyncController.sharedDeps === undefined) {
      AnaCareHoursSyncController.sharedDeps = createAnaCareSyncDependencies();
    }
    return AnaCareHoursSyncController.sharedDeps;
  }

  private static defaultRunnerFactory(): AnaCareHoursSyncRunner | null {
    if (AnaCareHoursSyncController.sharedRunner === undefined) {
      const deps = AnaCareHoursSyncController.resolveSharedDeps();
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

  private static defaultSyncRunRepositoryFactory(): SyncRunRepository | null {
    return AnaCareHoursSyncController.resolveSharedDeps()?.syncRunRepository ?? null;
  }

  /** Só para teste: força o próximo `defaultRunnerFactory()`/`defaultSyncRunRepositoryFactory()` a resolver de novo. */
  static resetSharedRunnerForTests(): void {
    AnaCareHoursSyncController.sharedRunner = undefined;
    AnaCareHoursSyncController.sharedDeps = undefined;
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  /**
   * F1 (migration 457): grava o progresso e NUNCA propaga uma falha de escrita para o chamador —
   * o sync é a missão, o registro é observabilidade. Mas também não engole em silêncio: uma falha
   * aqui vai para `reportError`, mesma convenção de `source` das demais chamadas deste controller.
   * Sem fonte configurada (`repository === null`), não há o que gravar — mesmo fail-closed do
   * runner, não é uma falha nova a reportar.
   */
  private async recordProgress(origin: 'manual' | 'cron', periodMonth: string, progress: SyncRunProgress): Promise<void> {
    const repository = this.syncRunRepositoryFactory();
    if (!repository) return;
    try {
      await repository.recordProgress(SYNC_SOURCE, periodMonth, progress);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `AnaCareHoursSyncController.recordProgress.${origin}` });
    }
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
    // F1 (migration 457): `body.data.month` pode chegar ausente — o corpo continua indo pro
    // runner exatamente como antes (`body.data.month`, possivelmente `undefined`; o RUNNER resolve
    // o mês corrente internamente via `monthResolver`). O outcome não devolve qual mês foi usado,
    // então para gravar o PROGRESSO no `(source, periodMonth)` certo, resolvemos aqui com a MESMA
    // função estática que é o default do runner (`AnaCareHoursSyncRunner.currentMonth`) — nunca
    // uma lógica de data própria, que arriscaria divergir. Ver "DECISÕES QUE TIVE DE TOMAR".
    const periodMonth = body.data.month ?? AnaCareHoursSyncRunner.currentMonth();
    const startedAt = Date.now();
    try {
      const outcome = await runner.run({
        origin,
        userId: origin === 'manual' ? this.actorUid(req) : null,
        month: body.data.month,
        cursor: body.data.cursor,
        budgetMs: body.data.budgetMs,
      });
      const isDone = outcome.nextCursor === null;
      await this.recordProgress(origin, periodMonth, {
        status: isDone ? 'done' : 'running',
        cursor: outcome.nextCursor,
        reservationsTotal: outcome.reservationsTotal,
        reservationsDone: outcome.reservationsDone,
        finishedAt: isDone ? new Date() : null,
        lastError: null,
      });
      res.status(200).json({
        success: true,
        deduped: outcome.deduped,
        shiftsRead: outcome.shiftsRead,
        reservationsProcessed: outcome.reservationsProcessed,
        shiftsWritten: outcome.shiftsWritten,
        nextCursor: outcome.nextCursor,
        // F1 (migration 457): expostos para o navegador poder mostrar progresso (F2, fora desta
        // fase) — reaproveitam os mesmos nomes do outcome, sem inventar formato novo.
        reservationsTotal: outcome.reservationsTotal,
        reservationsDone: outcome.reservationsDone,
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
      // F1 (migration 457): `status='failed'` + código ESTÁVEL (nunca `e.message` — a mensagem
      // pode carregar nome de paciente). `cursor`/contagens vão `null` DE PROPÓSITO: o repositório
      // usa `COALESCE` e preserva o último valor conhecido em vez de apagá-lo (design.md §F1).
      await this.recordProgress(origin, periodMonth, {
        status: 'failed',
        cursor: null,
        reservationsTotal: null,
        reservationsDone: null,
        finishedAt: new Date(),
        lastError: toStableErrorCode(e),
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
