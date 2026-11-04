import { addDays } from './dates';
import type { AnomalyCore, DailyCostPoint, DayKey, DetectedAnomalies } from './types';

/** DF-5: o dia mais recente completo precisa ser >= ANOMALY_FACTOR x a mediana dos ANOMALY_WINDOW_DAYS dias anteriores... */
export const ANOMALY_FACTOR = 2;
/** ...E a diferença precisa ser >= ANOMALY_MIN_DELTA unidades da moeda da conta. */
export const ANOMALY_MIN_DELTA = 5;
export const ANOMALY_WINDOW_DAYS = 7;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Regra de anomalia do painel (spec 082, DF-5), por serviço e por recurso.
 * - `latestCompleteDay`: o dia mais recente COMPLETO (o chamador o deriva de `dataUntil`); `null` -> histórico insuficiente.
 * - Janela = os ANOMALY_WINDOW_DAYS dias de calendário anteriores a ele. Se algum deles não tem NENHUMA linha de dado
 *   (em toda a série), o histórico é insuficiente e nada é calculado.
 * - Dia sem linha de uma entidade vale 0 na mediana.
 * - Entidade sem custo algum na janela ("nova"): sai com `isNew` e sem fator, nunca como anomalia; só aparece se o dia
 *   chega à diferença mínima (senão seria ruído).
 * Ordenado pela diferença (dia - mediana), maior primeiro.
 */
export function detectAnomalies(points: DailyCostPoint[], latestCompleteDay: DayKey | null): DetectedAnomalies {
  if (!latestCompleteDay) return { status: 'insufficient_history', items: [] };

  const windowDays: DayKey[] = [];
  for (let i = ANOMALY_WINDOW_DAYS; i >= 1; i--) windowDays.push(addDays(latestCompleteDay, -i));

  const daysWithData = new Set(points.map((p) => p.day));
  if (windowDays.some((d) => !daysWithData.has(d))) return { status: 'insufficient_history', items: [] };

  const byEntity = new Map<string, Map<DayKey, number>>();
  for (const p of points) {
    const key = `${p.kind}\u0000${p.name}`;
    const days = byEntity.get(key) ?? new Map<DayKey, number>();
    days.set(p.day, (days.get(p.day) ?? 0) + p.value);
    byEntity.set(key, days);
  }

  const items: AnomalyCore[] = [];
  for (const [key, days] of byEntity) {
    const dayValue = days.get(latestCompleteDay);
    if (dayValue === undefined) continue;
    const [kind, name] = key.split('\u0000') as [AnomalyCore['kind'], string];
    const window = windowDays.map((d) => days.get(d) ?? 0);
    const median7 = median(window);
    const delta = dayValue - median7;
    if (delta < ANOMALY_MIN_DELTA) continue;
    const isNew = window.every((v) => v === 0);
    if (isNew) {
      items.push({ kind, name, dayValue, median7, factor: null, isNew: true });
    } else if (median7 === 0) {
      items.push({ kind, name, dayValue, median7, factor: null, isNew: false });
    } else if (dayValue >= ANOMALY_FACTOR * median7) {
      items.push({ kind, name, dayValue, median7, factor: dayValue / median7, isNew: false });
    }
  }

  items.sort((a, b) => (b.dayValue - b.median7) - (a.dayValue - a.median7));
  return { status: 'ok', items };
}
