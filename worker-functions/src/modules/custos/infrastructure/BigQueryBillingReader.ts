import { BigQuery } from '@google-cloud/bigquery';
import type { BillingReader } from '../application/ports';
import {
  BillingReadError,
  NONE_KEY,
  type AiCallerCost,
  type BillingData,
  type BillingWindow,
  type DailyCostPoint,
  type DailyTotal,
  type MonthTotal,
  type ResourceCost,
  type SectorCost,
  type ServiceCost,
} from '../domain/types';

/** Tabela Detailed do billing export (spec §9.3). Sobrescrevível por `BILLING_EXPORT_TABLE`. */
export const DEFAULT_BILLING_TABLE = 'enlite-prd.billing_export.gcp_billing_export_resource_v1_01994D_5E747D_F222E1';
/** 1 GiB (DF-8): teto de bytes faturados de TODA consulta. */
export const MAX_BYTES_BILLED = '1073741824';
export const BILLING_LOCATION = 'US';
const TOP_RESOURCES = 30;
const TABLE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

/** Fatia mínima do cliente BigQuery que o leitor usa (permite injetar um dublê no teste). */
export interface BigQueryQueryClient {
  query(options: {
    query: string;
    params: Record<string, string>;
    location: string;
    maximumBytesBilled: string;
  }): Promise<[unknown[], ...unknown[]]>;
}

/** Custo líquido (spec §9.3): custo + créditos (negativos). */
const NET = 'cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)';
const SECTOR = "(SELECT value FROM UNNEST(labels) WHERE key = 'setor')";
const LABEL_SERVICE = "(SELECT value FROM UNNEST(labels) WHERE key = 'service')";
const LABEL_FUNCAO = "(SELECT value FROM UNNEST(labels) WHERE key = 'funcao')";
/** Todo filtro de partição usa `usage_start_time` e os parâmetros nomeados @from/@to (datas UTC, fim exclusivo). */
const PARTITION = 'usage_start_time >= TIMESTAMP(@from) AND usage_start_time < TIMESTAMP(@to)';

type Row = Record<string, unknown>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** TIMESTAMP do BigQuery chega como `BigQueryTimestamp` ({ value }) ou string. */
function toIso(v: unknown): string | null {
  const raw = v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isBytesLimit(err: unknown): boolean {
  const e = err as { errors?: Array<{ reason?: string }>; message?: string } | null;
  if (e?.errors?.some((x) => x.reason === 'bytesBilledLimitExceeded')) return true;
  return typeof e?.message === 'string' && /bytes billed/i.test(e.message);
}

/**
 * Leitor do billing export no BigQuery (spec 082, DF-3/DF-8). ÚNICA classe do repositório que importa `@google-cloud/bigquery`.
 * Toda consulta: filtro de partição por `usage_start_time`, `maximumBytesBilled` = 1 GiB, location US, parâmetros nomeados
 * (o único texto interpolado é o nome da tabela, validado por regex). Erros viram `BillingReadError` com código fixo.
 */
export class BigQueryBillingReader implements BillingReader {
  private readonly table: string;

  constructor(
    private readonly client: BigQueryQueryClient,
    table: string = process.env.BILLING_EXPORT_TABLE || DEFAULT_BILLING_TABLE,
  ) {
    if (!TABLE_PATTERN.test(table)) throw new Error('invalid billing table name');
    this.table = table;
  }

  static create(table?: string): BigQueryBillingReader {
    return new BigQueryBillingReader(new BigQuery({ location: BILLING_LOCATION }) as unknown as BigQueryQueryClient, table);
  }

  async read(w: BillingWindow): Promise<BillingData> {
    const t = `\`${this.table}\``;
    const month = { from: w.monthStart, to: w.monthEndExclusive };
    const [meta, daily, months, services, resources, sectors, dailyServices, dailyResources, ai, aiEstimated] = await Promise.all([
      this.run(`SELECT MAX(export_time) AS data_until, ANY_VALUE(currency) AS currency FROM ${t} WHERE ${PARTITION}`, { from: w.prevMonthStart, to: w.monthEndExclusive }),
      this.run(`SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY day ORDER BY day`, { from: w.prevMonthStart, to: w.monthEndExclusive }),
      this.run(`SELECT invoice.month AS month, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY month ORDER BY month`, { from: w.sixMonthsStart, to: w.monthEndExclusive }),
      this.run(`SELECT service.description AS service, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY service ORDER BY total DESC`, month),
      this.run(`SELECT service.description AS service, IFNULL(resource.name, '${NONE_KEY}') AS resource, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY service, resource ORDER BY total DESC LIMIT ${TOP_RESOURCES}`, month),
      this.run(`SELECT IFNULL(${SECTOR}, '${NONE_KEY}') AS sector, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY sector ORDER BY total DESC`, month),
      this.run(`SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, service.description AS name, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} GROUP BY day, name`, { from: w.dailyFrom, to: w.dailyToExclusive }),
      this.run(`SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, resource.name AS name, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} AND resource.name IS NOT NULL GROUP BY day, name`, { from: w.dailyFrom, to: w.dailyToExclusive }),
      this.run(`SELECT ${LABEL_SERVICE} AS caller, ${LABEL_FUNCAO} AS funcao, SUM(${NET}) AS total FROM ${t} WHERE ${PARTITION} AND (service.description LIKE 'Vertex AI%' OR service.description LIKE '%Gemini%') GROUP BY caller, funcao ORDER BY total DESC`, month),
      this.readAiEstimated(w),
    ]);

    const sixMonths: MonthTotal[] = months
      .map((r) => ({ month: String(r.month ?? '').replace(/^(\d{4})(\d{2})$/, '$1-$2'), total: num(r.total) }))
      .filter((m) => /^\d{4}-\d{2}$/.test(m.month) && m.month <= w.month)
      .slice(-6);

    return {
      currency: meta[0]?.currency ? String(meta[0].currency) : null,
      dataUntil: toIso(meta[0]?.data_until),
      dailyTotals: daily.map((r): DailyTotal => ({ day: String(r.day), value: num(r.total) })),
      months: sixMonths,
      byService: services.map((r): ServiceCost => ({ service: str(r.service, NONE_KEY), total: num(r.total) })),
      byResource: resources.map((r): ResourceCost => ({ service: str(r.service, NONE_KEY), resource: str(r.resource, NONE_KEY), total: num(r.total) })),
      bySector: sectors.map((r): SectorCost => ({ sector: str(r.sector, NONE_KEY), total: num(r.total) })),
      byAiCaller: [...ai.map((r): AiCallerCost => {
        const caller = typeof r.caller === 'string' && r.caller ? r.caller : null;
        return { caller: caller ?? NONE_KEY, funcao: str(r.funcao, NONE_KEY), total: num(r.total), source: caller ? 'billing' : 'unattributed' };
      }), ...aiEstimated],
      dailyByService: dailyServices.map((r): DailyCostPoint => ({ kind: 'service', name: str(r.name, NONE_KEY), day: String(r.day), value: num(r.total) })),
      dailyByResource: dailyResources.map((r): DailyCostPoint => ({ kind: 'resource', name: str(r.name, NONE_KEY), day: String(r.day), value: num(r.total) })),
    };
  }

  /**
   * Ponto de extensão da Fase 5 (T056): custo ESTIMADO por tokens a partir do dataset `ai_usage_logs` (DF-10).
   * Nesta fase não consulta nada: `byAiCaller` vem só da trilha do billing.
   */
  protected async readAiEstimated(_w: BillingWindow): Promise<AiCallerCost[]> {
    return [];
  }

  private async run(query: string, params: { from: string; to: string }): Promise<Row[]> {
    try {
      const [rows] = await this.client.query({ query, params, location: BILLING_LOCATION, maximumBytesBilled: MAX_BYTES_BILLED });
      return rows as Row[];
    } catch (err) {
      // Código fixo: o texto do erro do BigQuery nunca sai daqui.
      throw new BillingReadError(isBytesLimit(err) ? 'bytes_limit' : 'billing_query_failed');
    }
  }
}
