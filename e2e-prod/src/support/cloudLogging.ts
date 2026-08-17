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

/**
 * Status que valem NOVA TENTATIVA porque são transitórios do lado do Google, não
 * defeito nosso. `entries:list` devolve `500 INTERNAL "Internal error encountered"`
 * em rajadas: em 2026-08-17, entre 06:00 e 06:10 UTC, 6 de 15 chamadas do monitor
 * voltaram 500 (medido em serviceruntime.googleapis.com/api/request_count) e
 * derrubaram DOIS runs seguidos — em testes DIFERENTES, porque o sorteio era de
 * qual chamada pegava o blip. A própria doc do Google manda repetir 500/503 com
 * backoff exponencial.
 *
 * O que fica de FORA de propósito: 401/403 (falta `roles/logging.viewer`) e 400
 * (filtro inválido). Repetir não conserta e só atrasa o diagnóstico.
 */
const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 1 tentativa + 3 repetições. Pior caso ~2,8s de espera — cabe no timeout do teste. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 400;

/** Exponencial + jitter: evita que N chamadas em série repitam no mesmo instante. */
function backoffDelay(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * BASE_DELAY_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lista entradas de log que casam com o filtro (mais novas primeiro). */
export async function queryLogs(params: QueryLogsParams): Promise<LogEntry[]> {
  const token = await accessToken();
  const body = JSON.stringify({
    resourceNames: [`projects/${PROJECT_ID}`],
    filter: buildFilter(params),
    orderBy: 'timestamp desc',
    pageSize: params.limit ?? 20,
  });

  let lastError = 'sem detalhe';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://logging.googleapis.com/v2/entries:list', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // Socket cortado / DNS / TLS: transitório por natureza, mesma política do 5xx.
      lastError = `rede: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoffDelay(attempt));
      continue;
    }

    if (res.ok) {
      const parsed = (await res.json()) as { entries?: LogEntry[] };
      return parsed.entries ?? [];
    }

    lastError = `${res.status}: ${await res.text().catch(() => '')}`;
    if (!RETRIABLE_STATUS.has(res.status)) {
      throw new Error(`Cloud Logging ${lastError}`);
    }
    if (attempt === MAX_ATTEMPTS) break;

    const delay = backoffDelay(attempt);
    // Ruído deliberado no stdout do run: um retry silencioso esconderia que o
    // Google andou instável. Evidência, não silêncio.
    console.warn(
      `[cloudLogging] ${res.status} do Google na tentativa ${attempt}/${MAX_ATTEMPTS} — repetindo em ${delay}ms`,
    );
    await sleep(delay);
  }

  // Esgotou as tentativas → FALHA RUIDOSA, nunca lista vazia.
  // Quem consome isto afirma "ZERO `send_failed` nas últimas 24h". Devolver `[]`
  // quando a LEITURA falhou faria essa asserção passar por ausência de prova —
  // verde falso num gate que existe para pegar paciente real sem confirmação.
  throw new Error(
    `Cloud Logging falhou em ${MAX_ATTEMPTS} tentativas (último erro — ${lastError})`,
  );
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
