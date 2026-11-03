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
/** DF-21: `project` = `project.id` do export; `NONE_KEY` quando a linha não tem projeto. */
export interface ProjectCost { project: string; total: number }

export type AiCallerSource = 'billing' | 'estimated' | 'unattributed';
/** `total` é `null` quando o custo é desconhecido (estimativa de modelo sem preço na tabela de `aiPrices.ts`). `currency`: moeda da LINHA (billing/unattributed = a do export; estimated = USD). */
export interface AiCallerCost { caller: string; funcao: string; total: number | null; currency: string | null; source: AiCallerSource }

export type AnomalyKind = 'service' | 'resource';
/** Um ponto da série diária por serviço/recurso (custo líquido do dia). */
export interface DailyCostPoint { kind: AnomalyKind; name: string; day: DayKey; value: number }
export interface DailyTotal { day: DayKey; value: number }

/** Ponto de uma série diária de um item (dia sem linha = 0). */
export interface DayValue { day: DayKey; value: number }

/** O que a regra DF-5 decide sobre um serviço/recurso (sem a série e o detalhe, que o use case acrescenta). */
export interface AnomalyCore {
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
/** Status da resposta: `not_applicable` = mês FECHADO (DF-22); a detecção só olha o mês corrente e nada é calculado nem consultado. */
export type AnomalyResultStatus = AnomalyStatus | 'not_applicable';
/** Saída da regra pura `detectAnomalies`. */
export interface DetectedAnomalies { status: AnomalyStatus; items: AnomalyCore[] }

/** Um recurso dentro do detalhe de um serviço anômalo (spec §15). `resource === NONE_KEY` = custo sem `resource.name`. */
export interface AnomalyResourceDetail { resource: string; dayValue: number; median7: number; monthTotal: number }
export interface AnomalyDetail {
  /** Do dia 1 do mês do dia da anomalia até ele; dia sem linha = 0. */
  monthSeries: DayValue[];
  /** No máx. DETAIL_RESOURCES_MAX, por (dayValue − median7) desc. */
  resources: AnomalyResourceDetail[];
}
export interface AnomalyItem extends AnomalyCore {
  /** ≤ ANOMALY_SERIES_OUT_DAYS dias terminando em `anomalies.day`; dia sem linha = 0. */
  series: DayValue[];
  /** Só `kind='service'`, `!isNew`, nos ANOMALY_DETAIL_MAX de maior impacto. */
  detail?: AnomalyDetail;
}
export interface AnomalyRule { factor: number; minDelta: number; windowDays: number }
export interface AnomalyResult {
  status: AnomalyResultStatus;
  /** Último dia completo usado no cálculo; `null` quando `status` != 'ok' (nada foi calculado). */
  day: DayKey | null;
  rule: AnomalyRule;
  items: AnomalyItem[];
}

/** Linha bruta da consulta de detalhe: custo líquido de um recurso de um serviço num dia. */
export interface AnomalyDetailRow { day: DayKey; service: string; resource: string; value: number }
/** Janela da consulta de detalhe (datas UTC, fim exclusivo). */
export interface DetailRange { from: DayKey; toExclusive: DayKey }

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
  /** DF-21: a conta inteira, uma linha por `project.id`. */
  byProject: ProjectCost[];
  /** DF-20: meses com linhas (YYYY-MM), até 13, decrescente. */
  availableMonths: MonthKey[];
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
  /** Janela da série diária de anomalias: 15 dias terminando em min(hoje, último dia do mês pedido) — relativa ao MÊS pedido. */
  dailyFrom: DayKey;
  dailyToExclusive: DayKey;
  /** Janela de `availableMonths` (DF-20): do 1º dia de (mês de hoje − 12) até hoje inclusive. */
  availableFrom: DayKey;
  availableToExclusive: DayKey;
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
  byProject: ProjectCost[];
  availableMonths: MonthKey[];
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
