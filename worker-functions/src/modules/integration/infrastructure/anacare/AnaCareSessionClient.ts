/**
 * AnaCareSessionClient — cliente de sessão único do Ana Care (fase-2.md).
 *
 * Login por cookie (`sessionid`), CSRF de formulário Django (`csrftoken`), re-login automático
 * no 403, paginação `page_size=100` (NUNCA 500), filtro de universo D340 (`agency_id === 116`)
 * NO CLIENTE (o servidor ignora `?agency=` — fato medido F2/F12), e TODA chamada passando pelo
 * `AnaCareRateLimiter` compartilhado (limite de carga D341: fila sequencial, backoff, breaker).
 *
 * Distinto de `AnaCareClient.ts` (auth por `X-Agency-Key`, só nurses/hiring-types) — mecanismo
 * de acesso diferente, não reaproveitado aqui.
 *
 * Documento e agência do paciente só vêm no `patient` ANINHADO em `/api/shifts/`
 * (`/api/patients/` não traz — F13). Por isso este cliente nunca chama `/api/patients/`:
 * `AnaCareShiftsSourceReal` resolve tudo a partir de `/api/shifts/`. Uma segunda porta
 * (`AnaCarePatientApiReal`, reconciliação de paciente) foi desenhada sobre o mesmo iterador mas
 * não entrou nesta stage — reconciliação de paciente passou a ser manual (decisão do Gabriel,
 * 16/09), e depende do módulo `reconciliation` que só existe no `main` (#404).
 */

import { AnaCareRateLimiter } from './AnaCareRateLimiter';
import { AnaCareHttpError, AnaCareTimeoutError } from './AnaCareHttpError';
import { minimizeShiftOrSkip, type RawAnaCareShift } from './AnaCareFieldMinimization';
import type { ListShiftsResult, SourceShiftDTO } from '../../../anacare-hours/domain/AnaCareShiftsSource';
import { logger } from '@shared/logging';
import { isTransientHttpStatus } from '@shared/http/isTransientHttpStatus';

const DEFAULT_BASE_URL = 'https://admin.ana.care';
const LOGIN_PATH = '/users/admin/login/';
const SHIFTS_PATH = '/api/shifts/';
const PAGE_SIZE = 100; // fato medido F2: page_size=500 estoura timeout — nunca subir isso.
/** Enlite = agency_id 116 no Ana Care (F2, 50/50 amostrados na varredura de 15/09). */
export const ANACARE_ENLITE_AGENCY_ID = 116;

export interface DjangoPagedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface AnaCareSessionClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  rateLimiter?: AnaCareRateLimiter;
}

/** Cookie jar mínimo em memória: nome→valor, sem persistência (spec: cookie EM MEMÓRIA). */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    // `Headers.getSetCookie()` (Node >=18.14/undici) é o único jeito de ler MÚLTIPLOS
    // `Set-Cookie` — `.get('set-cookie')` colapsa em um só. Sem fallback: o runtime deste
    // serviço sempre tem o método (mesmo Node do resto do worker-functions).
    const setCookies = response.headers.getSetCookie();
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}

export class AnaCareSessionClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: AnaCareRateLimiter;
  private readonly cookies = new CookieJar();
  private loggedIn = false;

  constructor(options: AnaCareSessionClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.ANACARE_BASE_URL ?? DEFAULT_BASE_URL;
    this.username = options.username ?? process.env.ANACARE_USERNAME ?? '';
    this.password = options.password ?? process.env.ANACARE_PASS ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new AnaCareRateLimiter();

    if (!this.username || !this.password) {
      throw new Error(
        '[AnaCareSessionClient] ANACARE_USERNAME/ANACARE_PASS ausentes — credencial de pessoa já em uso (D350), sem usuário de integração dedicado.',
      );
    }
  }

  /**
   * Login CSRF: GET da página (pega csrftoken) + POST de credenciais (pega sessionid).
   * Entra na fila do rate limiter como uma ÚNICA tarefa (achado 1) — chamada pública, para
   * quem quiser forçar login isoladamente (ex.: testes).
   */
  async login(): Promise<void> {
    await this.rateLimiter.schedule(() => this.performLogin());
  }

  /**
   * Faz o login de fato (GET+POST). Só pode ser chamada de DENTRO de uma tarefa já agendada
   * no rate limiter (por `login()`, `ensureSessionAndFetch` ou o `fn` de `buildForceReloginFetch`) — nunca
   * direto, e nunca aninhando outro `rateLimiter.schedule(...)` aqui dentro (a fila é uma
   * corrente de promises: agendar de novo por dentro de uma tarefa em execução trava esperando
   * a própria tarefa terminar).
   */
  private async performLogin(): Promise<void> {
    const pageResponse = await this.rawFetch(LOGIN_PATH, { method: 'GET' });
    this.cookies.absorb(pageResponse);

    const csrfToken = this.cookies.get('csrftoken');
    if (!csrfToken) {
      throw new Error('[AnaCareSessionClient] login: csrftoken ausente na página de login');
    }

    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
      csrfmiddlewaretoken: csrfToken,
    }).toString();

    const postResponse = await this.rawFetch(LOGIN_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.cookies.header(),
        Referer: `${this.baseUrl}${LOGIN_PATH}`,
      },
      body,
    });
    this.cookies.absorb(postResponse);

    // Login bem-sucedido responde 302 + Set-Cookie: sessionid. Com `redirect: 'manual'` o 302
    // chega inteiro aqui e o cookie é absorvido. Se vier 200, o Django re-renderizou o formulário
    // — credencial rejeitada (ou o redirecionamento foi seguido e o cookie se perdeu).
    if (!this.cookies.get('sessionid')) {
      throw new AnaCareHttpError('POST', LOGIN_PATH, postResponse.status, await safeText(postResponse));
    }
    this.loggedIn = true;
  }

  /**
   * Roda DENTRO da fila do rate limiter (achado 1): a checagem "estou logado?" e a decisão de
   * logar acontecem no MESMO turno serializado da chamada HTTP, nunca antes de entrar na fila.
   * Isso garante que duas execuções concorrentes nunca vejam `loggedIn===false` ao mesmo tempo
   * — a segunda, ao rodar seu turno, já encontra `loggedIn===true` deixado pela primeira.
   */
  private async ensureSessionAndFetch(url: string, isAbsolute: boolean): Promise<Response> {
    if (!this.loggedIn) {
      await this.performLogin();
    }
    return this.fetchThrowingOnTransientStatus(
      url,
      { method: 'GET', headers: { Cookie: this.cookies.header() } },
      isAbsolute,
    );
  }

  /**
   * Idem, mas força reset de sessão antes (caminho do re-login em 403) — também DENTRO da
   * fila, para que o `cookies.clear()` nunca apague um cookie que outra chamada concorrente
   * acabou de escrever fora de turno.
   *
   * O `fn` agendado aqui é o alvo do retry transiente do `AnaCareRateLimiter` (5xx/429/timeout,
   * `withRetry`) — e o retry chama o MESMO `fn` de novo a cada tentativa. Sem a flag `hasRelogged`
   * (fechada nesta closure, não no estado da instância), um 5xx *depois* de um re-login já
   * bem-sucedido faria cada tentativa de retry refazer login inteiro (GET+POST) de novo — até
   * `maxAttempts` vezes — invalidando uma sessão que nunca esteve inválida e batendo no Ana Care
   * com requisições de login extras (bug nomeado, achado do code-review). `hasRelogged` só vira
   * `true` DEPOIS que `performLogin()` resolve — se o login em si falhar (transiente), o retry
   * seguinte tem de tentar logar de novo, não pular direto para o fetch sem sessão.
   */
  private buildForceReloginFetch(url: string, isAbsolute: boolean): () => Promise<Response> {
    let hasRelogged = false;
    return async () => {
      if (!hasRelogged) {
        this.loggedIn = false;
        this.cookies.clear();
        logger.warn({ msg: '[AnaCareSessionClient] 403 recebido — disparando re-login' });
        await this.performLogin();
        hasRelogged = true;
      }
      return this.fetchThrowingOnTransientStatus(
        url,
        { method: 'GET', headers: { Cookie: this.cookies.header() } },
        isAbsolute,
      );
    };
  }

  /**
   * Núcleo compartilhado de `requestJson`/`requestText`: resolve sessão (login se preciso),
   * faz o GET, e dispara o re-login de uma vez se a sessão tiver expirado (403/302). Devolve o
   * `Response` cru — quem chama decide como ler o corpo (`json()` ou `text()`).
   */
  private async requestRaw(url: string, isAbsolute: boolean): Promise<Response> {
    let response = await this.rateLimiter.schedule(() => this.ensureSessionAndFetch(url, isAbsolute));

    if (isSessionExpiredStatus(response.status)) {
      response = await this.rateLimiter.schedule(this.buildForceReloginFetch(url, isAbsolute));
    }

    return response;
  }

  /** GET autenticado com retry de re-login em 403 (uma vez), corpo JSON. */
  async requestJson<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = withQuery(path, query);
    const response = await this.requestRaw(url, false);

    if (!response.ok) {
      throw new AnaCareHttpError('GET', path, response.status, await safeText(response));
    }

    return (await response.json()) as T;
  }

  /**
   * GET autenticado com retry de re-login em 403 (uma vez), corpo TEXTO (HTML). Reaproveita a
   * MESMA sessão/rate limiter/re-login de `requestJson` — usado pelo `AnaCareEnliteDirectory`
   * para ler as páginas HTML do painel admin, que não têm equivalente em `/api/`.
   */
  async requestText(path: string, query: Record<string, string | number | undefined> = {}): Promise<string> {
    const url = withQuery(path, query);
    const response = await this.requestRaw(url, false);

    if (!response.ok) {
      throw new AnaCareHttpError('GET', path, response.status, await safeText(response));
    }

    return response.text();
  }

  /** Gera páginas de `path` com `page_size=100` (nunca 500), seguindo `next` até esgotar. */
  async *paginate<T>(path: string, query: Record<string, string | number | undefined>): AsyncGenerator<T[]> {
    let page = 1;
    let nextUrl: string | null = null;

    for (;;) {
      const data: DjangoPagedResponse<T> = nextUrl
        ? await this.requestJsonAbsolute<DjangoPagedResponse<T>>(nextUrl)
        : await this.requestJson<DjangoPagedResponse<T>>(path, { ...query, page, page_size: PAGE_SIZE });

      yield data.results;

      if (!data.next) return;
      nextUrl = data.next;
      page += 1;
    }
  }

  /**
   * Turnos na faixa `[from, to]` (`YYYY-MM-DD`, inclusive), já filtrados pelo universo D340 e
   * minimizados na borda.
   *
   * `month` é campo do OBJETO turno no payload (uma das 67 chaves), não parâmetro de filtro do
   * backend — `?month=YYYY-MM` é ignorado em silêncio e devolve o universo inteiro (medido ao
   * vivo 16/09: `?month=2026-08` deu `count=882776`, praticamente todas as 39 agências). O
   * backend aceita `min_date`/`max_date` (medido no mesmo dia: `count=3483` para uma janela de 7
   * dias) — por isso este cliente só fala em faixa de datas; quem só tem um mês (a porta de
   * domínio `AnaCareShiftsSource`, que mantém `month` como conceito legítimo) traduz com
   * `monthToDateRange` ANTES de chamar aqui — não é responsabilidade do cliente.
   *
   * `patient_id` nunca funcionou como filtro no servidor (ignorado em silêncio, medido 17/09) —
   * o nome certo é `patient`. `reservation_id` funciona e é usado pelo `AnaCareEnliteDirectory`
   * para restringir a leitura a uma reserva específica.
   */
  async listShifts(params: { from: string; to: string; patientId?: string; reservationId?: string }): Promise<ListShiftsResult> {
    const query: Record<string, string | number | undefined> = { min_date: params.from, max_date: params.to };
    if (params.patientId) query.patient = params.patientId;
    if (params.reservationId) query.reservation_id = params.reservationId;

    const shifts: SourceShiftDTO[] = [];
    let noProvider = 0;
    let noPatient = 0;
    const skippedNoProviderIds: string[] = [];
    const skippedNoPatientIds: string[] = [];

    for await (const page of this.paginate<RawAnaCareShift>(SHIFTS_PATH, query)) {
      for (const raw of page) {
        if (!isEnliteUniverseShift(raw)) continue;
        const result = minimizeShiftOrSkip(raw);
        if (result.ok) {
          shifts.push(result.dto);
        } else if (result.reason === 'no-provider') {
          noProvider += 1;
          skippedNoProviderIds.push(result.sourceShiftId);
        } else {
          noPatient += 1;
          skippedNoPatientIds.push(result.sourceShiftId);
        }
      }
    }

    // Um log por LOTE (não por turno) — id de turno é metadado operacional, não PII (contagem
    // zero é falha, nunca sucesso: só logamos quando há descarte de verdade).
    if (noProvider > 0 || noPatient > 0) {
      logger.warn({
        msg: '[AnaCareSessionClient] turnos descartados na minimização (sem prestador/paciente) — contados, nunca em silêncio',
        noProvider,
        noPatient,
        skippedNoProviderIds,
        skippedNoPatientIds,
      });
    }

    return { shifts, skipped: { noProvider, noPatient } };
  }

  /** Estado do disjuntor de carga (D341) — alimenta `getRetratoStatus()` da porta de horas. */
  get circuitBreakerOpen(): boolean {
    return this.rateLimiter.isOpen;
  }

  /** Um turno cru por id — usado por `getShift`/`fetchAllPatients` das portas. */
  async getRawShift(sourceShiftId: string): Promise<RawAnaCareShift | null> {
    try {
      return await this.requestJson<RawAnaCareShift>(`${SHIFTS_PATH}${sourceShiftId}/`);
    } catch (err) {
      if (err instanceof AnaCareHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Todos os turnos crus (sem minimizar) filtrados pelo universo D340 — base para `fetchAllPatients`. */
  async *iterateAgencyShiftsRaw(query: Record<string, string | number | undefined> = {}): AsyncGenerator<RawAnaCareShift[]> {
    for await (const page of this.paginate<RawAnaCareShift>(SHIFTS_PATH, query)) {
      yield page.filter(isEnliteUniverseShift);
    }
  }

  private async requestJsonAbsolute<T>(absoluteUrl: string): Promise<T> {
    const response = await this.requestRaw(absoluteUrl, true);

    if (!response.ok) throw new AnaCareHttpError('GET', absoluteUrl, response.status, await safeText(response));
    return (await response.json()) as T;
  }

  /**
   * Faz o fetch e LANÇA para status transiente (429/5xx) — é o que faz o
   * `AnaCareRateLimiter` (retry+backoff+breaker) reagir a falha real do Ana Care. 403 e outros
   * 4xx voltam como Response normal: 403 é tratado pelo re-login aqui em cima, e os demais
   * (404 etc.) viram `AnaCareHttpError` no chamador, sem contar para o breaker.
   */
  private async fetchThrowingOnTransientStatus(url: string, init: RequestInit, isAbsolute: boolean): Promise<Response> {
    const response = await this.rawFetch(url, init, isAbsolute);
    if (isTransientHttpStatus(response.status)) {
      throw new AnaCareHttpError(init.method as string, url, response.status, await safeText(response));
    }
    return response;
  }

  /**
   * ⚠️ `redirect: 'manual'` é OBRIGATÓRIO e não é detalhe de estilo.
   *
   * O `fetch` do Node segue redirecionamento por padrão, e o login do Ana Care responde
   * `302 + Set-Cookie: sessionid`. Seguindo o 302 automaticamente, o `Set-Cookie` do 302 se
   * PERDE (a Response final só carrega os cabeçalhos da última resposta); a página de destino
   * não reconhece a sessão e redireciona de volta ao login, e o cliente recebe 200 com o HTML
   * do formulário — login "falhando" com credencial correta. Medido ao vivo na stage em
   * 16/09/2026: o mesmo POST via `curl` sem seguir redirecionamento devolve 302 com o cookie.
   *
   * Isto escapou dos testes da F2 porque todos usam `fetchImpl` simulado, que devolvia o 302 com
   * o cookie direto ao código — o comportamento de seguir redirecionamento só existe no `fetch`
   * real. Cobertura de 100% não pega esta classe de defeito; só o teste de fumaça contra o
   * Ana Care real pega (ver `AnaCareSessionClient.smoke.ts`).
   */
  private async rawFetch(pathOrUrl: string, init: RequestInit, isAbsolute = false): Promise<Response> {
    const url = isAbsolute ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual' });
    } catch (err) {
      throw new AnaCareTimeoutError(init.method as string, url);
    }
  }
}

/**
 * Sessão expirada/ausente chega de DUAS formas no Ana Care: `403` na API, e `302` (redirecionamento
 * para o formulário de login) nas rotas que renderizam HTML. Antes do `redirect: 'manual'` o 302
 * era seguido pelo `fetch` e virava um 200 com o HTML do login — indistinguível de sucesso para
 * quem só olhava o status. Com o redirecionamento manual, os dois casos são detectáveis e disparam
 * o mesmo re-login.
 */
function isSessionExpiredStatus(status: number): boolean {
  return status === 403 || status === 302;
}

/**
 * Universo "paciente da Enlite" (D340, `docs/decisoes.md`): `patient.agency === 116` OU
 * (`patient.agency` nulo E prestador `nurse.agency === 116`). Ambiguidade (paciente do 2º grupo
 * com turno de OUTRO prestador de agência preenchida) é decidida por agregação entre turnos do
 * mesmo paciente — fora do escopo deste filtro por turno — e vai para a fila humana (D340),
 * não tratada aqui.
 */
function isEnliteUniverseShift(raw: RawAnaCareShift): boolean {
  if (raw.patient?.agency === ANACARE_ENLITE_AGENCY_ID) return true;
  return raw.patient?.agency == null && raw.nurse?.agency === ANACARE_ENLITE_AGENCY_ID;
}

/**
 * `YYYY-MM` → 1º e último dia do mês, em `YYYY-MM-DD` (UTC, sem depender de fuso local).
 * Último dia via `new Date(Date.UTC(year, month, 0))` — dia 0 do mês seguinte é o último dia
 * do mês pedido, e cobre corretamente 28/29 (fevereiro, incl. bissexto)/30/31 dias.
 */
export function monthToDateRange(month: string): { minDate: string; maxDate: string } {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr); // 1-12, e serve direto de "mês seguinte" 0-based p/ Date.UTC
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    minDate: `${yearStr}-${monthStr}-01`,
    maxDate: `${yearStr}-${monthStr}-${pad(lastDay)}`,
  };
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
