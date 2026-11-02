/**
 * A API do painel de custos (spec 082) — `GET /api/admin/costs/overview?month=YYYY-MM`, sob `platform_costs:read`.
 * Cada chamada é uma sincronização: o backend consulta o faturamento (BigQuery) e devolve tudo num payload; nada é guardado aqui.
 * Contrato: envelope `{success:true,data}` ou `{success:false,code[,retryAfterSeconds]}`. Os tipos espelham
 * `worker-functions/src/modules/custos/domain/types.ts` (só números e rótulos de serviço/recurso/setor — sem texto clínico, sem PII).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from './ApiError';

/** Valor que o backend usa quando a linha não tem setor / recurso / chamador. A tela traduz. */
export const COSTS_NONE_KEY = '__none__';

export interface CostMonthTotal { month: string; total: number }
export interface CostServiceRow { service: string; total: number }
export interface CostResourceRow { service: string; resource: string; total: number }
export interface CostSectorRow { sector: string; total: number }
export type CostAiCallerSource = 'billing' | 'estimated' | 'unattributed';
export interface CostAiCallerRow { caller: string; funcao: string; total: number; source: CostAiCallerSource }
export interface CostAnomalyItem {
  kind: 'service' | 'resource';
  name: string;
  dayValue: number;
  median7: number;
  /** `null` quando a mediana é 0. */
  factor: number | null;
  isNew: boolean;
}
export interface CostAnomalies { status: 'ok' | 'insufficient_history'; items: CostAnomalyItem[] }
export interface CostForecast { value: number | null; basis: 'linear'; daysCounted: number }

export interface CostOverview {
  month: string;
  /** `null` só no estado vazio. */
  currency: string | null;
  /** max(export_time) em ISO; `null` só no estado vazio. */
  dataUntil: string | null;
  monthTotal: number;
  prevMonthToDate: number | null;
  prevMonthTotal: number | null;
  forecast: CostForecast;
  months: CostMonthTotal[];
  byService: CostServiceRow[];
  byResource: CostResourceRow[];
  bySector: CostSectorRow[];
  byAiCaller: CostAiCallerRow[];
  anomalies: CostAnomalies;
}

/** Falha da API de custos: `code` estável (`sync_rate_limited`, `bytes_limit`, `billing_query_failed`, `invalid_month`). */
export class CostsApiError extends ApiError {
  readonly retryAfterSeconds?: number;
  constructor(code: string | undefined, status: number, retryAfterSeconds?: number) {
    super({ success: false, error: code ?? `HTTP ${status}`, code }, status);
    this.name = 'CostsApiError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class AdminCostsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL ??
      'http://localhost:8080';
  }

  /** `month` = 'YYYY-MM'; sem ele o backend usa o mês corrente. */
  async getOverview(month?: string): Promise<CostOverview> {
    const token = await this.authService.getIdToken();
    const q = month ? `?month=${encodeURIComponent(month)}` : '';
    const response = await fetch(`${this.baseURL}/api/admin/costs/overview${q}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const json = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      data?: CostOverview;
      code?: string;
      retryAfterSeconds?: number;
    };
    if (!response.ok || json.success === false) {
      throw new CostsApiError(json.code, response.status, json.retryAfterSeconds);
    }
    return json.data as CostOverview;
  }
}

export const AdminCostsApiService = new AdminCostsApiServiceClass();
