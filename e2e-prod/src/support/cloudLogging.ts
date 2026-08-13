/**
 * cloudLogging.ts — ler os LOGS REAIS de produção como fonte de verdade.
 *
 * Por que isto existe: "o endpoint devolveu 200" prova que a API respondeu, não
 * que o efeito aconteceu. Quem sabe se a mensagem saiu, se o evento foi criado,
 * se o gate de consentimento barrou, é o log estruturado que o backend emite.
 * Este helper transforma esse log em asserção de teste.
 *
 * Formato confirmado contra prod (não presumido):
 *   logName  = projects/enlite-prd/logs/run.googleapis.com%2Fstdout
 *   jsonPayload.message = 'admission.notifier.confirmation.sent'
 *   + campos soltos no mesmo jsonPayload (appointmentId, externalId, ...)
 *
 * Permissão: a SA do runner precisa de `roles/logging.viewer` no projeto.
 */
import { accessToken } from './gcp';

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'enlite-prd';
const SERVICE_NAME = process.env.LOG_SERVICE_NAME ?? 'worker-functions';

export interface LogEntry {
  timestamp: string;
  severity?: string;
  jsonPayload?: Record<string, unknown>;
  textPayload?: string;
}

export interface QueryLogsParams {
  /** Valor exato de `jsonPayload.message` (é assim que o backend loga). */
  message: string;
  /** Janela para trás, em minutos. */
  withinMinutes: number;
  /** Filtros extras de igualdade em campos do jsonPayload. */
  match?: Record<string, string>;
  limit?: number;
}

function buildFilter({ message, withinMinutes, match }: QueryLogsParams): string {
  const since = new Date(Date.now() - withinMinutes * 60_000).toISOString();
  const parts = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${SERVICE_NAME}"`,
    `jsonPayload.message="${message}"`,
    `timestamp>="${since}"`,
  ];
  for (const [k, v] of Object.entries(match ?? {})) {
    parts.push(`jsonPayload.${k}="${v}"`);
  }
  return parts.join(' AND ');
}

/** Lista entradas de log que casam com o filtro (mais novas primeiro). */
export async function queryLogs(params: QueryLogsParams): Promise<LogEntry[]> {
  const token = await accessToken();
  const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT_ID}`],
      filter: buildFilter(params),
      orderBy: 'timestamp desc',
      pageSize: params.limit ?? 20,
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Logging ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { entries?: LogEntry[] };
  return body.entries ?? [];
}

/**
 * Espera até UMA entrada aparecer (o log é assíncrono: o efeito acontece antes
 * de ficar consultável). Faz polling com backoff curto em vez de sleep cego.
 *
 * Devolve a entrada, ou null se estourar o tempo.
 */
export async function waitForLog(
  params: QueryLogsParams,
  { timeoutMs = 90_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<LogEntry | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await queryLogs({ ...params, limit: 1 });
    if (entries.length > 0) return entries[0] ?? null;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Açúcar de leitura: campo do jsonPayload como string. */
export function payloadString(entry: LogEntry | null, field: string): string | null {
  const v = entry?.jsonPayload?.[field];
  return typeof v === 'string' ? v : null;
}
