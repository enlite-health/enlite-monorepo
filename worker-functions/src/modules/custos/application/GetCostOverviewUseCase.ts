import { utcCivilDayOf } from '../../../shared/locale/civilClock';
import { ANOMALY_DETAIL_MAX, buildAnomalyDetail, buildSeries } from '../domain/buildAnomalyDetail';
import { addDays, addMonths, buildWindow, daysInMonth, isMonthKey, monthStartOf } from '../domain/dates';
import { ANOMALY_FACTOR, ANOMALY_MIN_DELTA, ANOMALY_WINDOW_DAYS, detectAnomalies } from '../domain/detectAnomalies';
import { forecastMonth } from '../domain/forecastMonth';
import { SyncRateLimitedError, type AiCallerCost, type AnomalyItem, type AnomalyResult, type BillingData, type CostOverview, type DayKey, type MonthKey } from '../domain/types';
import type { BillingReader } from './ports';

/** DF-8: no máximo 1 sincronização a cada 10 s, no servidor. */
export const MIN_SYNC_INTERVAL_MS = 10_000;

export class InvalidMonthError extends Error {
  constructor() {
    super('invalid_month');
    this.name = 'InvalidMonthError';
  }
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

/** DF-15: linha `estimated` só para chamador SEM linha `billing` (hoje só `sol`/Gemini API); `unattributed` fica intacta. */
function withoutEstimatedWhenBilled(rows: AiCallerCost[]): AiCallerCost[] {
  const billed = new Set(rows.filter((r) => r.source === 'billing').map((r) => r.caller));
  return rows.filter((r) => r.source !== 'estimated' || !billed.has(r.caller));
}

/**
 * Orquestra a porta `BillingReader` (spec 082, RF-3): consulta uma vez, calcula previsão (DF-6), anomalias (DF-5) e o
 * mês anterior até o mesmo dia. Limite de sincronização: guardado em memória do processo — a tentativa conta ao COMEÇAR
 * (mesmo que falhe), porque o que se protege é o custo da consulta. Com várias instâncias do Cloud Run o limite vale por instância.
 */
export class GetCostOverviewUseCase {
  private lastStartedAt: number | null = null;

  constructor(
    private readonly reader: BillingReader,
    private readonly now: () => Date = () => new Date(),
    private readonly minIntervalMs: number = MIN_SYNC_INTERVAL_MS,
  ) {}

  async execute(month?: string): Promise<CostOverview> {
    const today = utcCivilDayOf(this.now());
    const target: MonthKey = month ?? today.slice(0, 7);
    if (!isMonthKey(target)) throw new InvalidMonthError();

    const nowMs = this.now().getTime();
    if (this.lastStartedAt !== null && nowMs - this.lastStartedAt < this.minIntervalMs) {
      throw new SyncRateLimitedError(Math.ceil((this.minIntervalMs - (nowMs - this.lastStartedAt)) / 1000));
    }
    this.lastStartedAt = nowMs;

    const window = buildWindow(target, today);
    const data = await this.reader.read(window);

    const monthStart = monthStartOf(target);
    const monthEnd = addDays(monthStartOf(addMonths(target, 1)), -1);
    const prevStart = monthStartOf(addMonths(target, -1));
    const inMonth = data.dailyTotals.filter((d) => d.day >= monthStart && d.day <= monthEnd);
    const prevDays = data.dailyTotals.filter((d) => d.day >= prevStart && d.day < monthStart);

    const dataUntilDay: DayKey | null = data.dataUntil ? data.dataUntil.slice(0, 10) : null;
    // O dia de `dataUntil` pode estar parcial: só os dias ANTES dele contam como completos.
    const lastCompleteDay = dataUntilDay ? addDays(dataUntilDay, -1) : null;

    let prevMonthToDate: number | null = null;
    if (dataUntilDay && dataUntilDay >= monthStart && prevDays.length > 0) {
      const cutoff = dataUntilDay > monthEnd ? daysInMonth(target) : Number(dataUntilDay.slice(8, 10));
      prevMonthToDate = sum(prevDays.filter((d) => Number(d.day.slice(8, 10)) <= cutoff).map((d) => d.value));
    }

    const anomalies = await this.buildAnomalies(data, lastCompleteDay, window.dailyToExclusive);

    return {
      month: target,
      currency: data.currency,
      dataUntil: data.dataUntil,
      monthTotal: sum(inMonth.map((d) => d.value)),
      prevMonthToDate,
      prevMonthTotal: prevDays.length > 0 ? sum(prevDays.map((d) => d.value)) : null,
      forecast: forecastMonth(target, inMonth, lastCompleteDay),
      months: data.months,
      byService: data.byService,
      byResource: data.byResource,
      bySector: data.bySector,
      byAiCaller: withoutEstimatedWhenBilled(data.byAiCaller),
      byProject: data.byProject,
      availableMonths: data.availableMonths,
      anomalies,
    };
  }

  /**
   * Anomalias com série e detalhe (spec §15). O detalhe (`readAnomalyDetail`) roda DEPOIS do `read()` e só se houver >= 1
   * serviço anômalo (não-novo): em dia calmo não há consulta extra. Falha da consulta de detalhe propaga (502), sem "detalhe indisponível".
   */
  private async buildAnomalies(data: BillingData, lastCompleteDay: DayKey | null, toExclusive: DayKey): Promise<AnomalyResult> {
    const points = [...data.dailyByService, ...data.dailyByResource];
    const detected = detectAnomalies(points, lastCompleteDay);
    const rule = { factor: ANOMALY_FACTOR, minDelta: ANOMALY_MIN_DELTA, windowDays: ANOMALY_WINDOW_DAYS };
    if (detected.status !== 'ok' || !lastCompleteDay) return { status: detected.status, day: null, rule, items: [] };

    const day = lastCompleteDay;
    const items: AnomalyItem[] = detected.items.map((i) => ({ ...i, series: buildSeries(points, i.kind, i.name, day) }));
    // `detected.items` já vem por impacto desc: os primeiros ANOMALY_DETAIL_MAX serviços não-novos recebem detalhe.
    const detailed = items.filter((i) => i.kind === 'service' && !i.isNew).slice(0, ANOMALY_DETAIL_MAX);
    if (detailed.length > 0) {
      const names = detailed.map((i) => i.name);
      const from = [monthStartOf(day.slice(0, 7)), addDays(day, -ANOMALY_WINDOW_DAYS)].sort()[0];
      const rows = await this.reader.readAnomalyDetail({ from, toExclusive }, names);
      const details = buildAnomalyDetail(rows, day, names);
      for (const i of detailed) i.detail = details.get(i.name);
    }
    return { status: 'ok', day, rule, items };
  }
}
