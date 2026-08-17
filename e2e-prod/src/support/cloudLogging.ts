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

/**
 * Lidos POR CHAMADA, não no load do módulo. Em produção dá no mesmo (o Job injeta
 * as vars antes de qualquer consulta), mas um `const` de módulo captura o valor no
 * import — e aí o ramo do default e o ramo da var setada nunca coexistem no mesmo
 * processo, o que deixa o helper impossível de cobrir por inteiro.
 */
const projectId = (): string => process.env.GCP_PROJECT_ID ?? 'enlite-prd';
const serviceName = (): string => process.env.LOG_SERVICE_NAME ?? 'worker-functions';

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
    `resource.labels.service_name="${serviceName()}"`,
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

/**
 * 1 tentativa + 3 repetições. Espera acumulada de 2,8s a 4,0s com o jitter
 * (400-800 + 800-1200 + 1600-2000) — folgado dentro do `timeout: 60_000` do teste.
 */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 400;

/** Exponencial + jitter: evita que N chamadas em série repitam no mesmo instante. */
function backoffDelay(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * BASE_DELAY_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `fetch` pode rejeitar com coisa que não é Error; sem isto o relatório sai "[object Object]". */
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * O que UMA tentativa produziu: os dados, ou o motivo de ter falhado já classificado.
 *
 * `kind` é curto e vai para o stdout a cada retry; `detail` é o texto cheio (pode
 * embutir o corpo devolvido pelo Google) e só aparece na exceção final. Separados
 * de propósito: o corpo de um 400 costuma ecoar o filtro, e filtro nosso carrega
 * `patientId` — isso não tem por que ser repetido no log a cada tentativa.
 */
type Attempt =
  | { ok: true; entries: LogEntry[] }
  | { ok: false; kind: string; detail: string; retriable: boolean };

/**
 * Uma ida ao `entries:list`, com TODA falha possível já traduzida em `Attempt`.
 *
 * As três formas de falhar moram aqui juntas porque a decisão de repetir é uma só,
 * lá no laço: rede caída, status ruim e **200 com corpo que não é JSON** (proxy ou
 * cold start devolvendo HTML). Esse último escapava da política e subia como
 * `SyntaxError` cru, sem repetir e sem dizer que era do Cloud Logging.
 */
const fail = (kind: string, detail: string, retriable = true): Attempt => ({
  ok: false,
  kind,
  detail,
  retriable,
});

/** Rótulo honesto do que veio no lugar do objeto esperado (`typeof null` é 'object'). */
function jsonKind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

async function attemptOnce(token: string, body: string): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    // Socket cortado / DNS / TLS: transitório por natureza, mesma política do 5xx.
    return fail('rede', `rede: ${errMessage(err)}`);
  }

  if (!res.ok) {
    return fail(
      String(res.status),
      `${res.status}: ${await res.text().catch(() => '')}`,
      RETRIABLE_STATUS.has(res.status),
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return fail('corpo não-JSON', `corpo não-JSON: ${errMessage(err)}`);
  }

  /**
   * `entries:list` sempre responde um OBJETO. Array, escalar ou null aqui é
   * intermediário se metendo no caminho (ou mudança de contrato) — e é mais
   * perigoso que corpo ilegível, não menos:
   *
   *   JSON.parse('[]').entries  →  Array.prototype.entries, uma FUNÇÃO
   *   (essa função).length      →  0   (aridade, não "zero resultados")
   *
   * Sem esta guarda, `queryLogs` devolveria uma função tipada como `LogEntry[]` e o
   * `expect(falhas.length).toBe(0)` do smoke passaria — verde falso silencioso,
   * exatamente o que a política toda existe para impedir. Escalar e string dão
   * `undefined ?? []` = `[]`, que é o mesmo verde falso por outro caminho.
   */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('corpo inesperado', `corpo 200 não é objeto JSON (${jsonKind(parsed)})`);
  }

  return { ok: true, entries: (parsed as { entries?: LogEntry[] }).entries ?? [] };
}

/** Lista entradas de log que casam com o filtro (mais novas primeiro). */
export async function queryLogs(params: QueryLogsParams): Promise<LogEntry[]> {
  const token = await accessToken();
  const body = JSON.stringify({
    resourceNames: [`projects/${projectId()}`],
    filter: buildFilter(params),
    orderBy: 'timestamp desc',
    pageSize: params.limit ?? 20,
  });

  let lastError = 'sem detalhe';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptOnce(token, body);
    if (result.ok) return result.entries;

    lastError = result.detail;
    // Defeito NOSSO (filtro inválido, falta de `logging.viewer`): repetir não
    // conserta e só atrasa o diagnóstico.
    if (!result.retriable) throw new Error(`Cloud Logging ${lastError}`);
    if (attempt === MAX_ATTEMPTS) break;

    const delay = backoffDelay(attempt);
    // Ruído deliberado no stdout do run: um retry silencioso esconderia que o
    // Google andou instável. Evidência, não silêncio.
    console.warn(
      `[cloudLogging] ${result.kind} na tentativa ${attempt}/${MAX_ATTEMPTS} — repetindo em ${delay}ms`,
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
    await sleep(intervalMs);
  }
}

/** Açúcar de leitura: campo do jsonPayload como string. */
export function payloadString(entry: LogEntry | null, field: string): string | null {
  const v = entry?.jsonPayload?.[field];
  return typeof v === 'string' ? v : null;
}
