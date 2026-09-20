/**
 * src/modules/anacare-hours/infrastructure/AnaCareHoursSyncMetrics.ts
 *
 * F4 (task 4.9) — métrica de custo/consumo por rodada de sync (cron ou manual). Log ESTRUTURADO,
 * nunca payload/PII: só contagens, duração e origem (regra dura CLAUDE.md "Nunca logar PII").
 * `userId` só é gravado quando `origin === 'manual'` (D345/D346 — quem disparou).
 */

import { logger } from '@shared/logging';

export interface AnaCareHoursSyncMetric {
  event: 'anacare_hours_sync';
  origin: 'cron' | 'manual';
  userId: string | null;
  requests: number;
  retries: number;
  durationMs: number;
  deduped: boolean;
  /**
   * TAREFA D (gate `revisao-pr`, fecho 17/09): nome do erro quando a rodada FALHOU antes de
   * completar (ex.: `AnaCarePatientMonthCollisionError`) — sem isto, o detector de colisão dispara
   * e a métrica nunca é emitida (o `throw` escapa antes de `AnaCareHoursSyncRunner.run` chegar ao
   * `emitMetric` do caminho feliz). `undefined` = rodada terminou sem erro.
   */
  error?: string;
}

export type AnaCareHoursSyncMetricEmitter = (metric: AnaCareHoursSyncMetric) => void;

/** Emissor default — log estruturado via `@shared/logging` (nunca `console.*`, regra do CLAUDE.md do worker-functions). */
export const emitAnaCareHoursSyncMetric: AnaCareHoursSyncMetricEmitter = (metric) => {
  logger.info(metric);
};
