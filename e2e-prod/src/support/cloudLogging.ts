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
  | { ok: true; entries: LogEntry[]; nextPageToken?: string }
  | { ok: false; kind: string; detail: string; retriable: boolean };

/**
 * Construtor de falha. `retriable` é OBRIGATÓRIO de propósito: um default
 * `true` deixaria o esquecimento no lado perigoso — repetir 4× um 403 mascara
 * falta de `roles/logging.viewer`, que é justamente o que `RETRIABLE_STATUS`
 * existe para não deixar acontecer.
 */
const fail = (kind: string, detail: string, retriable: boolean): Attempt => ({
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

/**
 * Uma ida ao `entries:list`, com TODA falha possível já traduzida em `Attempt`.
 *
 * As CINCO formas de falhar moram aqui juntas porque a decisão de repetir é uma
 * só, lá no laço — uma por valor de `kind`: `rede` · `<status>` · `corpo
 * não-JSON` (proxy ou cold start devolvendo HTML) · `corpo inesperado` e
 * `entries inesperado` (200 com JSON de forma errada). As três últimas escapavam
 * da política: a primeira subia como `SyntaxError` cru, e as outras duas eram
 * piores — não faziam barulho nenhum (ver a guarda abaixo).
 */
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
    return fail('rede', `rede: ${errMessage(err)}`, true);
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
    return fail('corpo não-JSON', `corpo não-JSON: ${errMessage(err)}`, true);
  }

  /**
   * `entries:list` sempre responde um OBJETO, com `entries` array ou ausente.
   * Qualquer outra FORMA aqui é intermediário se metendo no caminho, e é mais
   * perigosa que corpo ilegível — porque não faz barulho:
   *
   *   JSON.parse('[]').entries   →  Array.prototype.entries, uma FUNÇÃO
   *                    .length   →  0   (aridade, não "zero resultados")
   *   {"entries": ""}            →  ""  →  .length também 0
   *
   * Nos dois casos o `expect(falhas.length).toBe(0)` do smoke PASSA por ausência
   * de prova — verde falso silencioso, exatamente o que a política toda existe
   * para impedir. Por isso validamos o continente E o conteúdo: sem a segunda
   * checagem, `queryLogs` ainda devolveria string/número tipado como `LogEntry[]`.
   *
   * ⚠️ O que estas guardas NÃO resolvem: um objeto SEM `entries` é indistinguível
   * do vazio legítimo, e o Google documenta um caso em que isso mente — `entries`
   * vazio COM `nextPageToken` significa "não terminei de varrer a janela", não
   * "não achei nada". Este helper não pagina (nunca lê `nextPageToken`), então
   * ainda pode ler busca-incompleta como zero. Fica como change própria; fechar
   * por allowlist de chaves do topo seria pior (quebraria a cada campo novo).
   */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('corpo inesperado', `corpo 200 não é objeto JSON (${jsonKind(parsed)})`, true);
  }

  // `null`/ausente é vazio legítimo (o Google omite `entries` quando não há match).
  const entries = (parsed as { entries?: unknown }).entries ?? [];
  if (!Array.isArray(entries)) {
    return fail(
      'entries inesperado',
      `200 com entries que não é array (${jsonKind(entries)})`,
      true,
    );
  }

  // Mesmo rigor do `entries`: token de forma errada não passa em silêncio, senão
  // uma varredura incompleta viraria "zero" (é exatamente o risco de baixo).
  const token_ = (parsed as { nextPageToken?: unknown }).nextPageToken;
  if (token_ !== undefined && token_ !== null && typeof token_ !== 'string') {
    return fail(
      'nextPageToken inesperado',
      `200 com nextPageToken que não é string (${jsonKind(token_)})`,
      true,
    );
  }

  return {
    ok: true,
    entries: entries as LogEntry[],
    ...(typeof token_ === 'string' && token_.length > 0 ? { nextPageToken: token_ } : {}),
  };
}

/** Uma PÁGINA, com a política de retry aplicada. Lança se não conseguir ler. */
async function fetchPage(
  token: string,
  body: string,
): Promise<{ entries: LogEntry[]; nextPageToken?: string }> {
  let lastError = 'sem detalhe';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptOnce(token, body);
    if (result.ok) {
      return {
        entries: result.entries,
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      };
    }

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
 * Teto de páginas. É válvula de segurança, não orçamento: bater nele LANÇA, em vez
 * de devolver o que juntou. Devolver seria dizer "zero" sem ter terminado de olhar.
 */
const MAX_PAGES = 20;

/**
 * Lista entradas de log que casam com o filtro (mais novas primeiro).
 *
 * Pagina até ter resposta CONCLUSIVA. Isto não é refinamento: a doc do
 * `entries.list` diz que `entries` vazio COM `nextPageToken` significa *"the
 * search found no log entries so far but it did not have time to search all the
 * possible log entries"* — ou seja, **"não terminei", não "não achei"**. Parar na
 * primeira página faria o smoke afirmar "zero `send_failed` nas últimas 24h" a
 * partir de uma varredura pela metade: ausência de prova virando prova, que é a
 * doença que este helper inteiro existe para não ter.
 */
export async function queryLogs(params: QueryLogsParams): Promise<LogEntry[]> {
  const token = await accessToken();
  const limit = params.limit ?? 20;
  const filter = buildFilter(params);
  const acc: LogEntry[] = [];
  let pageToken: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = JSON.stringify({
      resourceNames: [`projects/${projectId()}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: limit,
      ...(pageToken ? { pageToken } : {}),
    });

    const { entries, nextPageToken } = await fetchPage(token, body);
    acc.push(...entries);

    // Já tenho o que foi pedido: não preciso terminar a varredura.
    if (acc.length >= limit) return acc.slice(0, limit);
    // Sem token = o Google terminou de olhar. Aqui `[]` é conclusão, não ignorância.
    if (!nextPageToken) return acc;

    pageToken = nextPageToken;
  }

  // Saiu do laço = o teto acabou antes da varredura. Devolver `acc` aqui seria
  // dizer "zero" sem ter terminado de olhar; então LANÇA.
  throw new Error(
    `Cloud Logging não terminou a varredura em ${MAX_PAGES} páginas ` +
      `(${acc.length} entrada(s) até aqui, ainda com nextPageToken) — ` +
      `concluir "zero" daqui seria verde falso`,
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
