/**
 * AxonicoApiClient — implementação HTTP da porta `IAxonicoApiClient`.
 *
 * Fluxo e formatos medidos por HTTP real em 18/09/2026 contra PRODUÇÃO do Axonico (não existe
 * sandbox conhecido) — ver `docs/funcionalidades/integracao-axonico/estado-integracao-axonico.md`.
 * NENHUM teste desta suíte chama a API real: `fetch` é sempre mockado (regra dura da change).
 *
 * Padrões copiados (DESENHO, não código literal — ver cabeçalhos de cada método):
 *   - Fábricas `fromEnv()`/`fromSecretManager()`/`create()` e cache de token em memória:
 *     `TalentumApiClient.ts`.
 *   - Base URL configurável por env, com default de produção: `AnaCareClient.ts` (`DEFAULT_BASE_URL`
 *     + `process.env.<X>_BASE_URL`). NÃO copiado: o `BASE_URL` hardcoded de
 *     `TalentumApiClient.ts:28` — esse não aceita override e quebraria a F4 (e2e contra stub).
 *   - Re-login em 401 com UM retry, closure local (nunca estado da instância, nunca loop):
 *     `AnaCareSessionClient.buildForceReloginFetch`/`requestRaw`. Diferença medida: lá o gatilho é
 *     403/302; aqui é 401 (copiado o DESENHO, não o código de status).
 */

import { logger } from '@shared/logging';
import type {
  IAxonicoApiClient,
  AxonicoPatientMatch,
  DedupeParams,
  SubmitComprobanteParams,
  AxonicoSubmitResult,
} from '../domain/IAxonicoApiClient';
import {
  AxonicoValidationError,
  AxonicoBusinessError,
  AxonicoAuthError,
  AxonicoIndeterminateWriteError,
} from './AxonicoErrors';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

/**
 * Default de produção — confirmado por prova real em 18/09/2026: é o host que serve
 * `POST /api/login`, `POST /api/paciente/filter`, `POST /api/comprobante/filter` e
 * `PUT /api/comprobante` (comprobante `1407706`). `api.his.axonico.ar` é o FRONT (SPA), nunca a
 * API — nunca usar como default aqui.
 */
const DEFAULT_BASE_URL = 'https://api.apiws.axonico.ar';
const SECRET_USERNAME = 'axonico-username';
const SECRET_PASSWORD = 'axonico-password';
const TAG = '[AxonicoApiClient]';

// Constantes de contrato — SÓ estas, nunca `matricula` (que é derivada da sessão).
const TIPO_PREST = 'P';
const PRESTACION_MEDICAMENTO = 'P';
/** "SIN DEFINIR PROFESIONAL" — decisão revisável (design.md §F1), não verdade eterna. */
const MATRICULA_SOLICITANTE = '999999';

// ─────────────────────────────────────────────────────────────────
// Internal session type
// ─────────────────────────────────────────────────────────────────

interface AxonicoSession {
  accessToken: string;
  /**
   * Matrícula do profissional logado — SHALL vir da resposta de login (`medico.matricula`,
   * MEDIDO por HTTP real em 18/09/2026: é bloco IRMÃO de `data`, ao lado de `links`,
   * `menuOpcionesNiveles` e `permisos` — `data.matricula` nunca existiu), NUNCA de uma constante
   * literal (risco de faturamento: um `matricula` hardcoded lançaria a prestação para a
   * matrícula ERRADA se a credencial mudar). Decisão desta implementação (design.md deixa
   * "resposta do login OU `medicoParametroPortal/filter`" em aberto): usamos o campo da resposta
   * do login por ser o dado já disponível no mesmo passo, sem uma segunda chamada de rede a cada
   * `ensureAuth()`. Se o Axonico não devolver `medico.matricula` (ausente, vazio ou inválido) no
   * login, o login falha explicitamente — nunca cai num valor cravado.
   */
  matricula: string;
}

// ─────────────────────────────────────────────────────────────────
// Response shapes (medidos) — só o suficiente para o parse, não o contrato completo
// ─────────────────────────────────────────────────────────────────

interface AxonicoLoginResponseBody {
  data?: { accessToken?: string };
  /**
   * `unknown`, não `string`: MESMO motivo já documentado em `AxonicoMedicoParametroPortalEntry`
   * — esta API comprovadamente serializa numérico como string em outros campos. `parseMatricula`
   * decide o que é matrícula válida, nunca um `as`.
   */
  medico?: { matricula?: unknown };
}

interface AxonicoPacienteCobertura {
  nro_afiliado?: string;
  obra_social?: string;
  plan?: string;
}

interface AxonicoPacienteFilterEntry {
  historia_clinica?: string;
  coberturas?: AxonicoPacienteCobertura[];
}

interface AxonicoPacienteFilterResponseBody {
  data?: AxonicoPacienteFilterEntry[];
}

interface AxonicoComprobanteFilterResponseBody {
  data?: unknown[];
}

interface AxonicoSubmitResponseBody {
  data?: {
    numero_comprobante?: string;
    cod_autorizacion?: string;
    detalle?: Array<{ cod_autorizacion?: string | null }>;
  };
}

interface AxonicoMedicoParametroPortalEntry {
  // `unknown`, não `number`: a asserção de tipo do `as` não é validação, e esta API comprovadamente
  // serializa numérico como string em outros campos (`cantidad: String(cantidad)` no submit) — o
  // parse runtime de `getCantidadMaxPrestaciones` decide o que é número válido (D371).
  cantidad_max_prestaciones?: unknown;
}

interface AxonicoMedicoParametroPortalResponseBody {
  data?: AxonicoMedicoParametroPortalEntry[];
}

interface AxonicoErrorResponseBody {
  data?: { errors?: Record<string, string[]>; message?: string };
}

// ─────────────────────────────────────────────────────────────────
// AxonicoApiClient
// ─────────────────────────────────────────────────────────────────

export class AxonicoApiClient implements IAxonicoApiClient {
  private readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  /** Relógio injetável — nunca `Date.now()` direto no corpo de `submitComprobante` (D370: teste
   *  roda com relógio fixado). Default de produção usa o relógio real. */
  private readonly now: () => Date;
  private session: AxonicoSession | null = null;

  constructor(username: string, password: string, baseUrl?: string, now?: () => Date) {
    this.username = username;
    this.password = password;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.now = now ?? (() => new Date());
  }

  // ── Static factories (padrão TalentumApiClient/AnaCareClient) ───────────

  /** Usa `AXIONICO_USERNAME`/`AXIONICO_PASSWORD` do ambiente (nomes medidos no `.env` real, com
   *  o "I" — não normalizamos a grafia deles). Intencionado para local/teste. */
  static fromEnv(now?: () => Date): AxonicoApiClient {
    const username = process.env.AXIONICO_USERNAME;
    const password = process.env.AXIONICO_PASSWORD;
    if (!username || !password) {
      throw new Error(`${TAG} fromEnv: AXIONICO_USERNAME and AXIONICO_PASSWORD must be set`);
    }
    const baseUrl = process.env.AXONICO_BASE_URL;
    return new AxonicoApiClient(username, password, baseUrl, now);
  }

  /** Busca as credenciais no GCP Secret Manager. Para produção (Cloud Run). */
  static async fromSecretManager(now?: () => Date): Promise<AxonicoApiClient> {
    // Dynamic require mantém o GCP SDK fora do bundle de teste quando não usado (padrão
    // TalentumApiClient/AnaCareClient).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager') as {
      SecretManagerServiceClient: new () => {
        accessSecretVersion(req: { name: string }): Promise<[{
          payload?: { data?: { toString(): string } };
        }]>;
      };
    };
    const client = new SecretManagerServiceClient();
    const project = process.env.GCP_PROJECT_ID ?? 'enlite-prd';

    const [usernameRes] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/${SECRET_USERNAME}/versions/latest`,
    });
    const [passwordRes] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/${SECRET_PASSWORD}/versions/latest`,
    });

    const username = usernameRes.payload?.data?.toString();
    const password = passwordRes.payload?.data?.toString();
    if (!username || !password) {
      throw new Error(`${TAG} fromSecretManager: secrets returned empty values`);
    }

    const baseUrl = process.env.AXONICO_BASE_URL;
    return new AxonicoApiClient(username, password, baseUrl, now);
  }

  /** Fábrica preferencial: env quando presente (local/test), Secret Manager em produção. */
  static async create(now?: () => Date): Promise<AxonicoApiClient> {
    if (process.env.AXIONICO_USERNAME && process.env.AXIONICO_PASSWORD) {
      return AxonicoApiClient.fromEnv(now);
    }
    return AxonicoApiClient.fromSecretManager(now);
  }

  // ── Private: login e request com re-login em 401 (um retry, sem loop) ──

  private async login(): Promise<AxonicoSession> {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login_sist: this.username,
        pass_encrypt_sist: this.password,
        origen: 'web',
      }),
    });

    if (!res.ok) {
      throw new Error(`${TAG} login failed — HTTP ${res.status}`);
    }

    const body = (await res.json()) as AxonicoLoginResponseBody;
    const accessToken = body.data?.accessToken;
    const matricula = parseMatricula(body.medico?.matricula);

    if (!accessToken) {
      throw new Error(`${TAG} login succeeded but data.accessToken was not present`);
    }
    if (matricula === null) {
      // Falha explícita — nunca cai num `matricula` cravado (risco de faturamento, design.md §F1).
      throw new Error(`${TAG} login succeeded but medico.matricula was not present`);
    }

    const session: AxonicoSession = { accessToken, matricula };
    this.session = session;
    return session;
  }

  private async ensureSession(): Promise<AxonicoSession> {
    if (this.session === null) {
      return this.login();
    }
    return this.session;
  }

  /**
   * Executa `fn` com a sessão atual; em 401, faz UM re-login e repete `fn` exatamente uma vez
   * (closure local via o parâmetro `attempt`, não estado da instância — mesmo desenho de
   * `AnaCareSessionClient.buildForceReloginFetch`). Um segundo 401 é erro definitivo, sem
   * terceira tentativa.
   *
   * `allowReplay` (default `true`) é `false` só para a ESCRITA (`put()`/`submitComprobante`): um
   * 401 não prova que o servidor deixou de aplicar o `PUT /api/comprobante` (token pode expirar
   * entre o processamento e a resposta; a borda pode devolver 401 com o PUT já aplicado) —
   * replayar arriscaria faturar duas vezes e registrar uma. LEITURA continua replayando (login,
   * `findPatientByDni`, `checkExistingComprobante`, `getCantidadMaxPrestaciones`).
   */
  private async withReauth<T>(
    method: string,
    path: string,
    fn: (session: AxonicoSession) => Promise<Response>,
    parseSuccess: (res: Response) => Promise<T>,
    options: { allowReplay?: boolean } = {}
  ): Promise<T> {
    const { allowReplay = true } = options;
    const session = await this.ensureSession();
    let res = await fn(session);

    if (res.status === 401) {
      logger.warn({ msg: `${TAG} 401 recebido — disparando re-login`, path, allowReplay });
      this.session = null;

      if (!allowReplay) {
        // Sessão já invalidada acima (próxima chamada — de qualquer método — relogará), mas ESTA
        // escrita não é repetida: ver AxonicoIndeterminateWriteError.
        throw new AxonicoIndeterminateWriteError(method, path);
      }

      const reloggedSession = await this.login();
      res = await fn(reloggedSession);

      if (res.status === 401) {
        throw new AxonicoAuthError(method, path);
      }
    }

    if (!res.ok) {
      await this.throwTypedError(method, path, res);
    }

    return parseSuccess(res);
  }

  private async throwTypedError(method: string, path: string, res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as AxonicoErrorResponseBody;

    if (res.status === 422) {
      throw new AxonicoValidationError(method, path, body.data?.errors ?? {});
    }
    // 400/403/412/500 — erro de negócio/servidor (data.message).
    throw new AxonicoBusinessError(method, path, res.status, body.data?.message ?? `HTTP ${res.status}`);
  }

  /**
   * `buildBody` recebe a sessão ATUAL no momento de cada tentativa — importante para
   * `checkExistingComprobante`/`submitComprobante`, cujo corpo carrega `matricula` (derivada da
   * sessão): se um 401 disparar re-login no meio da chamada, o retry monta o corpo de novo com a
   * sessão pós-relogin, nunca reaproveitando um `matricula` capturado antes do re-login.
   */
  private async post<T>(
    path: string,
    buildBody: (session: AxonicoSession) => unknown,
    parseSuccess: (res: Response) => Promise<T>
  ): Promise<T> {
    return this.withReauth(
      'POST',
      path,
      (session) =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify(buildBody(session)),
        }),
      parseSuccess
    );
  }

  /** `allowReplay: false` (Conserto F1-3) — ver `withReauth`: um 401 no PUT nunca replaya. */
  private async put<T>(
    path: string,
    buildBody: (session: AxonicoSession) => unknown,
    parseSuccess: (res: Response) => Promise<T>
  ): Promise<T> {
    return this.withReauth(
      'PUT',
      path,
      (session) =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify(buildBody(session)),
        }),
      parseSuccess,
      { allowReplay: false }
    );
  }

  // ── IAxonicoApiClient implementation ────────────────────────────

  async findPatientByDni(dni: string): Promise<AxonicoPatientMatch | null> {
    const result = await this.post<AxonicoPacienteFilterEntry[]>(
      '/api/paciente/filter',
      () => ({
        filters: {
          doc_tipo: '0',
          nro_doc: dni,
          estado: 'A',
          whereHas: { pacienteCobertura: { estado: 'A' } },
        },
        orderBy: { apellido_nombre: 'asc', historia_clinica: 'asc' },
        pagination: 15,
      }),
      async (res) => {
        const body = (await res.json()) as AxonicoPacienteFilterResponseBody;
        return body.data ?? [];
      }
    );

    const entry = result[0];
    const historiaClinica = entry?.historia_clinica;
    const nroCobertura = entry?.coberturas?.[0]?.nro_afiliado;

    if (!entry || !historiaClinica || !nroCobertura) {
      return null;
    }

    return { historiaClinica, nroCobertura };
  }

  async checkExistingComprobante(params: DedupeParams): Promise<boolean> {
    const { historiaClinica, nroCobertura, serviceCodes, serviceDate } = params;

    const count = await this.post<number>(
      '/api/comprobante/filter',
      (session) => ({
        filters: {
          historia_clinica: historiaClinica,
          nro_cobertura: nroCobertura,
          servicio_origen: serviceCodes.servicioOrigen,
          fecha_desde: `${formatDiaCivilParaAxonico(serviceDate)} 00:00:00`,
          fecha_hasta: `${formatDiaCivilParaAxonico(serviceDate)} 23:59:59`,
          whereIn: { estado: ['A', 'P'] },
          whereHasWith: {
            comprobanteDetalle: {
              codigo_especialidad: serviceCodes.codigoEspecialidad,
              codigo: serviceCodes.codigo,
              subcodigo: serviceCodes.subcodigo,
              matricula: session.matricula,
            },
          },
        },
        relations: ['comprobanteDetalle'],
        date_filter: 'fecha',
        pagination: -1,
      }),
      async (res) => {
        const body = (await res.json()) as AxonicoComprobanteFilterResponseBody;
        return (body.data ?? []).length;
      }
    );

    return count > 0;
  }

  async submitComprobante(params: SubmitComprobanteParams): Promise<AxonicoSubmitResult> {
    const { historiaClinica, nroCobertura, serviceCodes, serviceDate, cantidad } = params;

    // `fecha` = dia civil do pedido (`serviceDate`, string 'YYYY-MM-DD') + hora do INSTANTE do
    // envio (D370) — `this.now()`, nunca `Date.now()` direto, para o teste poder fixar o relógio.
    const fecha = `${formatDiaCivilParaAxonico(serviceDate)} ${formatTime(this.now())}`;

    const buildBody = (session: AxonicoSession) => {
      const detalle = omitEmptyStrings({
        servicio_origen: serviceCodes.servicioOrigen,
        prestacion_medicamento: PRESTACION_MEDICAMENTO,
        matricula: session.matricula,
        codigo: serviceCodes.codigo,
        subcodigo: serviceCodes.subcodigo,
        cantidad: String(cantidad),
        codigo_especialidad: serviceCodes.codigoEspecialidad,
      });

      const payload = omitEmptyStrings({
        historia_clinica: historiaClinica,
        servicio_origen: serviceCodes.servicioOrigen,
        tipo_prest: TIPO_PREST,
        nro_cobertura: nroCobertura,
        fecha,
        matricula_solicitante: MATRICULA_SOLICITANTE,
      });

      return { ...payload, detalle: [detalle] };
    };

    return this.put<AxonicoSubmitResult>('/api/comprobante', buildBody, async (res) => {
      const body = (await res.json()) as AxonicoSubmitResponseBody;
      const numeroComprobante = body.data?.numero_comprobante;
      // ⚠️ cod_autorizacion vem do TOPO da resposta, não de detalle[0] (que veio `null` na prova
      // de 18/09/2026) — fixado por teste unitário dedicado.
      const codAutorizacion = body.data?.cod_autorizacion;

      if (!numeroComprobante || !codAutorizacion) {
        // Sucesso é status 200 E presença de numero_comprobante (design.md §F1) — não um booleano.
        throw new AxonicoBusinessError(
          'PUT',
          '/api/comprobante',
          res.status,
          'HTTP 200 sem numero_comprobante/cod_autorizacion no corpo — resposta inesperada'
        );
      }

      return { numeroComprobante, codAutorizacion };
    });
  }

  async getCantidadMaxPrestaciones(): Promise<number | null> {
    const entries = await this.post<AxonicoMedicoParametroPortalEntry[]>(
      '/api/medicoParametroPortal/filter',
      (session) => ({
        filters: { matricula: session.matricula },
        pagination: -1,
      }),
      async (res) => {
        const body = (await res.json()) as AxonicoMedicoParametroPortalResponseBody;
        return body.data ?? [];
      }
    );

    return parseCantidadMaxPrestaciones(entries[0]?.cantidad_max_prestaciones);
  }
}

/**
 * Parse runtime (não asserção de tipo) de `cantidad_max_prestaciones` — D371: sem leitura
 * CONFIÁVEL do teto, o use case recusa (`null`), nunca compara com NaN (que daria `hours > NaN`
 * = `false` e deixaria o lançamento passar, invertendo a regra).
 *
 * Aceita `number` finito e `string` numérica finita (a API serializa número como string em outros
 * campos — recusar `"24"` recusaria o caminho feliz real). Tudo mais (ausente, `null`, `NaN`,
 * `Infinity`, booleano, objeto, array, string não-numérica, ou número <= 0 — teto zero/negativo é
 * leitura sem sentido, não "teto zero recusa tudo") vira `null`.
 */
function parseCantidadMaxPrestaciones(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    n = Number(raw);
  } else {
    // boolean, object, array, "" ou qualquer outro tipo — nunca coerção implícita.
    return null;
  }

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  return n;
}

/**
 * Parse runtime (não asserção de tipo) de `medico.matricula` — mesma disciplina de
 * `parseCantidadMaxPrestaciones` (D371): sem leitura CONFIÁVEL da matrícula, o login recusa
 * (`null`), nunca cai num valor cravado (risco de faturamento, design.md §F1).
 *
 * Aceita `string` não-vazia (após trim) e `number` finito (vira `String(n)` — a API serializa
 * numérico como string em outros campos, mesmo motivo de `AxonicoMedicoParametroPortalEntry`).
 * Tudo mais (ausente, `null`, `""`, booleano, objeto, array, `NaN`/`Infinity`) vira `null`.
 */
function parseMatricula(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed !== '' ? trimmed : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Helpers de formato
// ─────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `'YYYY-MM-DD'` → `dd/MM/yyyy`, medido no formato real do Axonico. Recebe o dia civil como
 * STRING (nunca `Date` — um dia civil não tem instante, e `Date` obrigaria escolher um fuso).
 * Parser honesto: LANÇA se a entrada não casar o formato esperado, em vez de produzir uma data
 * incorreta em silêncio.
 */
function formatDiaCivilParaAxonico(diaCivil: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(diaCivil);
  if (!match) {
    throw new Error(`${TAG} formatDiaCivilParaAxonico: '${diaCivil}' não é um dia civil 'YYYY-MM-DD'`);
  }
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** `HH:mm:ss`, medido no formato real do Axonico. */
function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * Campos vazios são OMITIDOS do JSON, nunca `""` (medido — design.md §F1). Remove só chaves cujo
 * valor é a string vazia; `undefined`/`null` não são o caso medido aqui, então não são tratados.
 */
function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== '') {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
