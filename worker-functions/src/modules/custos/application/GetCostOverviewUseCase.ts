import { utcCivilDayOf } from '../../../shared/locale/civilClock';
import { addDays, addMonths, buildWindow, daysInMonth, isMonthKey, monthStartOf } from '../domain/dates';
import { detectAnomalies } from '../domain/detectAnomalies';
import { forecastMonth } from '../domain/forecastMonth';
import { SyncRateLimitedError, type CostOverview, type DayKey, type MonthKey } from '../domain/types';
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

    const data = await this.reader.read(buildWindow(target, today));

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

    const anomalies = detectAnomalies([...data.dailyByService, ...data.dailyByResource], lastCompleteDay);

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
      byAiCaller: data.byAiCaller,
      anomalies,
    };
  }
}
