import { addDays, monthStartOf } from './dates';
import { ANOMALY_WINDOW_DAYS, median } from './detectAnomalies';
import type { AnomalyDetail, AnomalyDetailRow, AnomalyKind, DailyCostPoint, DayKey, DayValue } from './types';

/** Spec §15: detalhe só nos 5 serviços anômalos de maior impacto. */
export const ANOMALY_DETAIL_MAX = 5;
/** Recursos listados no detalhe de um serviço. */
export const DETAIL_RESOURCES_MAX = 10;
/** Dias da série (`series`) de cada item de anomalia, terminando no dia da anomalia. */
export const ANOMALY_SERIES_OUT_DAYS = 14;
/** Teto de linhas da consulta de detalhe: estourar é erro (`billing_query_failed`), não truncamento. Valor de segurança, não medido (spec §12). */
export const DETAIL_QUERY_ROW_CAP = 20_000;

function range(from: DayKey, to: DayKey): DayKey[] {
  const out: DayKey[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Série de `ANOMALY_SERIES_OUT_DAYS` dias terminando em `day` para um serviço/recurso; dia sem linha = 0 (spec §15). */
export function buildSeries(points: DailyCostPoint[], kind: AnomalyKind, name: string, day: DayKey): DayValue[] {
  const byDay = new Map<DayKey, number>();
  for (const p of points) if (p.kind === kind && p.name === name) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.value);
  return range(addDays(day, -(ANOMALY_SERIES_OUT_DAYS - 1)), day).map((d) => ({ day: d, value: byDay.get(d) ?? 0 }));
}

/**
 * Detalhe de cada serviço anômalo (spec §15), a partir das linhas dia x serviço x recurso:
 * - `monthSeries`: do dia 1 do mês de `day` até `day`, somando os recursos; dia sem linha = 0.
 * - `resources`: por recurso, `dayValue` (o dia), `median7` (mediana dos ANOMALY_WINDOW_DAYS dias anteriores, dia sem linha = 0)
 *   e `monthTotal` (soma do dia 1 do mês de `day` até `day`); ordenados por (dayValue − median7) desc e cortados em DETAIL_RESOURCES_MAX.
 */
export function buildAnomalyDetail(rows: AnomalyDetailRow[], day: DayKey, services: string[]): Map<string, AnomalyDetail> {
  const monthFirst = monthStartOf(day.slice(0, 7));
  const windowDays = range(addDays(day, -ANOMALY_WINDOW_DAYS), addDays(day, -1));
  const out = new Map<string, AnomalyDetail>();

  for (const service of services) {
    const mine = rows.filter((r) => r.service === service);
    const perDay = new Map<DayKey, number>();
    const perResource = new Map<string, Map<DayKey, number>>();
    for (const r of mine) {
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.value);
      const days = perResource.get(r.resource) ?? new Map<DayKey, number>();
      days.set(r.day, (days.get(r.day) ?? 0) + r.value);
      perResource.set(r.resource, days);
    }
    const monthDays = range(monthFirst, day);
    const resources = [...perResource].map(([resource, days]) => ({
      resource,
      dayValue: days.get(day) ?? 0,
      median7: median(windowDays.map((d) => days.get(d) ?? 0)),
      monthTotal: monthDays.reduce((s, d) => s + (days.get(d) ?? 0), 0),
    }));
    resources.sort((a, b) => (b.dayValue - b.median7) - (a.dayValue - a.median7));
    out.set(service, {
      monthSeries: monthDays.map((d) => ({ day: d, value: perDay.get(d) ?? 0 })),
      resources: resources.slice(0, DETAIL_RESOURCES_MAX),
    });
  }
  return out;
}
