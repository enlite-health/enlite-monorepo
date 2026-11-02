/**
 * Painel de custos (spec 082) — contrato de `GET /api/admin/costs/overview` (spec §9.2) e dados brutos que a porta
 * `BillingReader` devolve. Só números e rótulos de recurso/serviço/setor: nenhum texto clínico, nenhuma PII.
 */

/** 'YYYY-MM'. */
export type MonthKey = string;
/** 'YYYY-MM-DD' (UTC). */
export type DayKey = string;

/** Valor usado quando a linha de custo não tem setor / recurso / chamador. A tela traduz. */
export const NONE_KEY = '__none__';

export interface MonthTotal { month: MonthKey; total: number }
export interface ServiceCost { service: string; total: number }
export interface ResourceCost { service: string; resource: string; total: number }
export interface SectorCost { sector: string; total: number }

export type AiCallerSource = 'billing' | 'estimated' | 'unattributed';
/** `total` é `null` quando o custo é desconhecido (estimativa de modelo sem preço na tabela de `aiPrices.ts`). `currency`: moeda da LINHA (billing/unattributed = a do export; estimated = USD). */
export interface AiCallerCost { caller: string; funcao: string; total: number | null; currency: string | null; source: AiCallerSource }

export type AnomalyKind = 'service' | 'resource';
/** Um ponto da série diária por serviço/recurso (custo líquido do dia). */
export interface DailyCostPoint { kind: AnomalyKind; name: string; day: DayKey; value: number }
export interface DailyTotal { day: DayKey; value: number }

export interface AnomalyItem {
  kind: AnomalyKind;
  name: string;
  dayValue: number;
  median7: number;
  /** `null` quando a mediana é 0 (serviço/recurso novo ou esparso): não há razão a mostrar. */
  factor: number | null;
  /** Sem histórico na janela: marcado "novo", não anomalia. */
  isNew: boolean;
}
export type AnomalyStatus = 'ok' | 'insufficient_history';
export interface AnomalyResult { status: AnomalyStatus; items: AnomalyItem[] }

export interface Forecast { value: number | null; basis: 'linear'; daysCounted: number }

export interface CostOverview {
  month: MonthKey;
  /** `null` só no estado vazio (export sem linhas na janela). */
  currency: string | null;
  /** max(export_time); `null` só no estado vazio. */
  dataUntil: string | null;
  monthTotal: number;
  prevMonthToDate: number | null;
  prevMonthTotal: number | null;
  forecast: Forecast;
  months: MonthTotal[];
  byService: ServiceCost[];
  byResource: ResourceCost[];
  bySector: SectorCost[];
  byAiCaller: AiCallerCost[];
  anomalies: AnomalyResult;
}

/** Janelas (datas UTC, fim exclusivo) que o use case pede ao leitor. Toda consulta filtra a partição por elas. */
export interface BillingWindow {
  month: MonthKey;
  monthStart: DayKey;
  monthEndExclusive: DayKey;
  prevMonthStart: DayKey;
  /** Início da janela dos 6 meses (o primeiro dia de month-5). */
  sixMonthsStart: DayKey;
  /** Janela da série diária de anomalias (últimos 15 dias, até hoje inclusive). */
  dailyFrom: DayKey;
  dailyToExclusive: DayKey;
}

/** Dados brutos do faturamento para uma janela. O leitor não calcula previsão nem anomalia. */
export interface BillingData {
  currency: string | null;
  dataUntil: string | null;
  /** Custo líquido por dia, do mês anterior ao fim do mês pedido. */
  dailyTotals: DailyTotal[];
  months: MonthTotal[];
  byService: ServiceCost[];
  byResource: ResourceCost[];
  bySector: SectorCost[];
  byAiCaller: AiCallerCost[];
  dailyByService: DailyCostPoint[];
  dailyByResource: DailyCostPoint[];
}

export type BillingErrorCode = 'billing_query_failed' | 'bytes_limit';

/** Erro do leitor. A mensagem é FIXA: nunca carrega o texto cru do BigQuery. */
export class BillingReadError extends Error {
  /** `reason` = `errors[0].reason` do BigQuery; `causeName` = `name` do erro original. Nunca o `message`. */
  constructor(
    public readonly code: BillingErrorCode,
    public readonly reason?: string,
    public readonly causeName?: string,
  ) {
    super(code);
    this.name = 'BillingReadError';
  }
}

/** Sincronização pedida antes de passar o intervalo mínimo (DF-8). */
export class SyncRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('sync_rate_limited');
    this.name = 'SyncRateLimitedError';
  }
}
