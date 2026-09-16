/**
 * src/modules/anacare-hours/application/AnaCareHoursSyncRunner.ts
 *
 * F4 (tasks 4.8/4.9) — DESENHO mínimo do "job" que o botão "Sincronizar agora" e o Cloud Scheduler
 * vão chamar via a MESMA rota interna (fase-4.md linha 13-15: "a mesma rota interna do job... passa
 * pelo MESMO limitador... nunca um caminho paralelo sem limite"). Aqui o "limitador" é o
 * `AnaCareHoursSyncGuard` (dedup de disparo concorrente) — o limitador de carga real (D341) e o
 * upsert do retrato mensal são 4.1-4.7, BLOQUEADOS por F2/F3, e não entram aqui.
 *
 * Fonte: `AnaCareShiftsSource` (adapter FALSO da F1, `FakeAnaCareShiftsSource`) — nunca uma chamada
 * real ao Ana Care (proibido nesta rodada).
 */

import type { AnaCareShiftsSource } from '../domain/AnaCareShiftsSource';
import { AnaCareHoursSyncGuard } from './AnaCareHoursSyncGuard';
import { emitAnaCareHoursSyncMetric, type AnaCareHoursSyncMetricEmitter } from '../infrastructure/AnaCareHoursSyncMetrics';

export interface AnaCareHoursSyncTrigger {
  origin: 'cron' | 'manual';
  userId: string | null;
}

export interface AnaCareHoursSyncOutcome {
  requests: number;
  retries: number;
  shiftsRead: number;
  deduped: boolean;
}

export class AnaCareHoursSyncRunner {
  constructor(
    private readonly source: AnaCareShiftsSource,
    private readonly guard: AnaCareHoursSyncGuard<{ requests: number; retries: number; shiftsRead: number }> = new AnaCareHoursSyncGuard(),
    private readonly emitMetric: AnaCareHoursSyncMetricEmitter = emitAnaCareHoursSyncMetric,
    private readonly monthResolver: () => string = AnaCareHoursSyncRunner.currentMonth,
  ) {}

  static currentMonth(): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${now.getUTCFullYear()}-${month}`;
  }

  /**
   * Roda uma sincronização. Concorrência: duas chamadas simultâneas (manual + cron) resultam em
   * UMA rodada real (`deduped: false`) e a(s) outra(s) compartilham o resultado (`deduped: true`)
   * — nenhuma rodada extra bate na fonte. Todo disparo, deduped ou não, emite a métrica de
   * custo/consumo (4.9) — inclusive a chamada deduped, para a origem concorrente ficar visível.
   */
  async run(trigger: AnaCareHoursSyncTrigger): Promise<AnaCareHoursSyncOutcome> {
    const startedAt = Date.now();
    const { result, deduped } = await this.guard.run(async () => {
      // 1 chamada à fonte por rodada real; a fonte falsa nunca falha (retries = 0 nesta fase).
      const shifts = await this.source.listShifts({ month: this.monthResolver() });
      return { requests: 1, retries: 0, shiftsRead: shifts.length };
    });

    const durationMs = Date.now() - startedAt;
    this.emitMetric({
      event: 'anacare_hours_sync',
      origin: trigger.origin,
      userId: trigger.origin === 'manual' ? trigger.userId : null,
      requests: deduped ? 0 : result.requests,
      retries: result.retries,
      durationMs,
      deduped,
    });

    return { ...result, deduped };
  }
}
