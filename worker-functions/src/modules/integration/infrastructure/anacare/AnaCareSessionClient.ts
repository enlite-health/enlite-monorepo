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
import { minimizeShiftDTO, type RawAnaCareShift } from './AnaCareFieldMinimization';
import type { SourceShiftDTO } from '../../../anacare-hours/domain/AnaCareShiftsSource';
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
   * no rate limiter (por `login()`, `ensureSessionAndFetch` ou `forceReloginAndFetch`) — nunca
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
   */
  private async forceReloginAndFetch(url: string, isAbsolute: boolean): Promise<Response> {
    this.loggedIn = false;
    this.cookies.clear();
    logger.warn({ msg: '[AnaCareSessionClient] 403 recebido — disparando re-login' });
    await this.performLogin();
    return this.fetchThrowingOnTransientStatus(
      url,
      { method: 'GET', headers: { Cookie: this.cookies.header() } },
      isAbsolute,
    );
  }

  /** GET autenticado com retry de re-login em 403 (uma vez). */
  async requestJson<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = withQuery(path, query);

    let response = await this.rateLimiter.schedule(() => this.ensureSessionAndFetch(url, false));

    if (response.status === 403) {
      response = await this.rateLimiter.schedule(() => this.forceReloginAndFetch(url, false));
    }

    if (!response.ok) {
      throw new AnaCareHttpError('GET', path, response.status, await safeText(response));
    }

    return (await response.json()) as T;
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

  /** Turnos do mês, já filtrados pelo universo D340 e minimizados na borda. */
  async listShifts(params: { month: string; patientId?: string }): Promise<SourceShiftDTO[]> {
    const query: Record<string, string | number | undefined> = { month: params.month };
    if (params.patientId) query.patient_id = params.patientId;

    const out: SourceShiftDTO[] = [];
    for await (const page of this.paginate<RawAnaCareShift>(SHIFTS_PATH, query)) {
      for (const raw of page) {
        if (isEnliteUniverseShift(raw)) {
          out.push(minimizeShiftDTO(raw));
        }
      }
    }
    return out;
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
    let response = await this.rateLimiter.schedule(() => this.ensureSessionAndFetch(absoluteUrl, true));

    if (response.status === 403) {
      response = await this.rateLimiter.schedule(() => this.forceReloginAndFetch(absoluteUrl, true));
    }

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

  private async rawFetch(pathOrUrl: string, init: RequestInit, isAbsolute = false): Promise<Response> {
    const url = isAbsolute ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new AnaCareTimeoutError(init.method as string, url);
    }
  }
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
