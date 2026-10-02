/**
 * TalentumApiClient — infrastructure service for the Talentum.chat outbound API (v2).
 *
 * Spec 040: a conta da Enlite migrou para a API v2 (`api.v2.talentum.chat`, Origin
 * `www.v2.talentum.chat`) em 01/10/2026; a API antiga responde 403. A interface
 * `ITalentumApiClient` foi mantida: o `projectId` é o `_id` do projeto v2, o link de
 * candidatura agora é uma página WEB derivada do `publicId` (não há mais bot WhatsApp).
 *
 * Auth strategy: RSA-OAEP encrypted password → cookie-based session (tl_auth + tl_refresh).
 * Token lifetime: server issues ~3h tokens; we refresh 10 000 s before expiry as a safety margin.
 *
 * Factory priority (CA-1.8):
 *   1. If TALENTUM_API_EMAIL + TALENTUM_API_PASSWORD are in env → fromEnv() (local / test)
 *   2. Otherwise → fromSecretManager() (production via GCP)
 */

import crypto from 'crypto';
import type {
  ITalentumApiClient,
  CreatePrescreeningInput,
  CreatePrescreeningResult,
  UpdatePrescreeningInput,
  ListPrescreeningsOpts,
  TalentumProject,
  TalentumQuestion,
  TalentumQuestionWithId,
  TalentumCandidatesPage,
} from '../domain/ITalentumApiClient';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

export const DEFAULT_TALENTUM_BASE_URL = 'https://api.v2.talentum.chat';
export const TALENTUM_ORIGIN = 'https://www.v2.talentum.chat';
const ORIGIN = TALENTUM_ORIGIN;

/**
 * Link público (página web) do pré-screening, derivado do `publicId` — a v2 não devolve
 * campo de URL. Padrão extraído do bundle do front v2 (`public/pre-screening/:id/chat`).
 */
export function buildPublicPrescreeningUrl(publicId: string): string {
  return `${TALENTUM_ORIGIN}/public/pre-screening/${publicId}/chat`;
}

/** `POST /projects` rejeita `name` > 50 caracteres (400 na v2 real, spec 040 §P5). */
export const TALENTUM_PROJECT_NAME_MAX = 50;

/**
 * Título de vaga → nome/título aceito pela v2: corta de forma determinística em 50 caracteres
 * (e tira o espaço que sobrar na ponta). Títulos curtos passam intactos.
 */
export function toV2ProjectName(title: string): string {
  return title.slice(0, TALENTUM_PROJECT_NAME_MAX).trimEnd();
}

/**
 * Resolve a base URL da Talentum a cada chamada (nunca no load do módulo — o
 * jest troca a env entre casos). e2e aponta para o stub local — `docker-compose.test.yml`;
 * produção/stage não setam a env → host v2 de produção.
 */
function talentumBaseUrl(): string {
  return process.env.TALENTUM_API_BASE_URL?.trim() || DEFAULT_TALENTUM_BASE_URL;
}

// RSA-2048 public key used by Talentum to receive encrypted passwords.
const RSA_PUBLIC_KEY_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtsKAWr0jt+CcSObbas2q' +
  'WVY8iooGBorFVC7RqBszOIdX4CCTF5n+KThsyVYpU8CCdhu0JZejAKyqO7ZwF75i' +
  'GtTc762ePGifLQhRoknnbZZfuBGuM6WnzmTNsYtV5TTiA+e2GSUt9yjBgtZjcVlG' +
  'Q61RCLSN5BuiiWIC4TcLErPluHRF6v40J8CjnZT2rbouZSvT0gygEm2QPWpn5S9a' +
  'kKoF0JNTdy1ywAc1bzQyHll7qcLCQLzrNUb6fNatz7aLChAiYtZ8Z6GS4HgSx5UY' +
  'jMZuXLNFw5j79I7LdzBx7lt2HT+QFJgvMENOteUsvcm46PkJ5EVzj76kP5fblDx8' +
  '3wIDAQAB';

// ─────────────────────────────────────────────────────────────────
// Internal auth session type
// ─────────────────────────────────────────────────────────────────

interface AuthSession {
  tlAuth: string;
  tlRefresh: string;
  /** Epoch ms at which the session should be considered expired and refreshed. */
  expiresAt: number;
}

function errorHint(status: number): string {
  if (status === 404) return ' (projeto não existe na Talentum v2; rode a reconciliação)';
  if (status === 403) return ' (sem permissão neste projeto da Talentum v2 — conta VIEWER)';
  return '';
}

/** Pergunta do domínio → corpo v2 (`desiredResponse`→`idealResponse`; campos sem equivalente vão vazios). */
function toV2Question(q: TalentumQuestion & { questionId?: string }) {
  return {
    question: q.question,
    type: 'text' as const,
    responseType: q.responseType,
    idealResponse: q.desiredResponse,
    acceptableResponse: '',
    redFlags: '',
    validation: '',
    weight: q.weight,
    required: q.required,
    analyzed: q.analyzed,
    earlyStoppage: q.earlyStoppage,
    ...(q.questionId ? { questionId: q.questionId } : {}),
  };
}

interface V2ProjectListItem {
  _id: string;
  name: string;
  status?: string;
  type?: string;
  myRole?: string;
}

// ─────────────────────────────────────────────────────────────────
// TalentumApiClient
// ─────────────────────────────────────────────────────────────────

export class TalentumApiClient implements ITalentumApiClient {
  private readonly email: string;
  private readonly password: string;
  private auth: AuthSession | null = null;

  constructor(email: string, password: string) {
    this.email = email;
    this.password = password;
  }

  // ── Static factories ────────────────────────────────────────────

  /**
   * Creates an instance using TALENTUM_API_EMAIL / TALENTUM_API_PASSWORD env vars.
   * Intended for local development and test environments.
   */
  static fromEnv(): TalentumApiClient {
    const email = process.env.TALENTUM_API_EMAIL;
    const password = process.env.TALENTUM_API_PASSWORD;
    if (!email || !password) {
      throw new Error(
        'TalentumApiClient.fromEnv: TALENTUM_API_EMAIL and TALENTUM_API_PASSWORD must be set'
      );
    }
    return new TalentumApiClient(email, password);
  }

  /**
   * Creates an instance by fetching credentials from GCP Secret Manager.
   * Intended for production (Cloud Run / Cloud Functions) deployments.
   */
  static async fromSecretManager(): Promise<TalentumApiClient> {
    // Dynamic require keeps the GCP SDK out of the test/dev bundle when not needed.
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

    const [emailRes] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/talentum-api-email/versions/latest`,
    });
    const [passwordRes] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/talentum-api-password/versions/latest`,
    });

    const email = emailRes.payload?.data?.toString();
    const password = passwordRes.payload?.data?.toString();

    if (!email || !password) {
      throw new Error('TalentumApiClient.fromSecretManager: secrets returned empty values');
    }

    return new TalentumApiClient(email, password);
  }

  /**
   * Preferred factory: uses env vars when present (local/test), falls back to
   * Secret Manager in production. Satisfies CA-1.8.
   */
  static async create(): Promise<TalentumApiClient> {
    if (process.env.TALENTUM_API_EMAIL && process.env.TALENTUM_API_PASSWORD) {
      return TalentumApiClient.fromEnv();
    }
    return TalentumApiClient.fromSecretManager();
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Encrypts a plaintext password with the Talentum RSA-2048 public key using
   * OAEP-SHA256 padding, as required by the /auth/login endpoint.
   */
  private encryptPassword(plaintext: string): string {
    const pem =
      `-----BEGIN PUBLIC KEY-----\n` +
      RSA_PUBLIC_KEY_B64.match(/.{1,64}/g)!.join('\n') +
      `\n-----END PUBLIC KEY-----`;

    const encrypted = crypto.publicEncrypt(
      {
        key: pem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(plaintext)
    );

    return encrypted.toString('base64');
  }

  /**
   * Authenticates against the Talentum API and stores the resulting session
   * cookies. Called automatically by ensureAuth() when the session is missing
   * or expired.
   */
  private async login(): Promise<void> {
    const res = await fetch(`${talentumBaseUrl()}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        email: this.email,
        password: this.encryptPassword(this.password),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[TalentumApiClient] login failed — HTTP ${res.status}: ${body}`
      );
    }

    // Extract Set-Cookie headers. getSetCookie() is available in Node ≥18 / undici.
    const rawCookies: string[] =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];

    let tlAuth: string | undefined;
    let tlRefresh: string | undefined;

    for (const cookie of rawCookies) {
      const name = cookie.split('=')[0]?.trim();
      const value = cookie.split('=')[1]?.split(';')[0]?.trim();
      if (name === 'tl_auth') tlAuth = value;
      if (name === 'tl_refresh') tlRefresh = value;
    }

    if (!tlAuth || !tlRefresh) {
      throw new Error(
        `[TalentumApiClient] login succeeded but tl_auth/tl_refresh cookies were not found. ` +
        `Set-Cookie headers: ${JSON.stringify(rawCookies)}`
      );
    }

    // Expire locally 10 000 s (~2.7 h) before the server-issued expiry to avoid
    // race conditions where a token appears valid locally but is rejected by the API.
    this.auth = {
      tlAuth,
      tlRefresh,
      expiresAt: Date.now() + 10_000 * 1000,
    };
  }

  /**
   * Returns a ready-to-use Cookie header string, refreshing the session first
   * if it is missing or has expired.
   */
  private async ensureAuth(): Promise<string> {
    if (this.auth === null || Date.now() >= this.auth.expiresAt) {
      await this.login();
    }
    // After login() auth is guaranteed to be non-null
    return `tl_auth=${this.auth!.tlAuth}; tl_refresh=${this.auth!.tlRefresh}`;
  }

  /**
   * Generic request helper. Handles auth, serialisation, and error propagation.
   * Always includes the response body in error messages (CA-1.7). Erros mantêm o formato
   * `... — HTTP <status>: ...` porque os use cases casam por `HTTP 403` / `HTTP 404`;
   * 404 e 403 em `/projects/:id…` ganham uma frase que os torna distinguíveis.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const cookie = await this.ensureAuth();

    const headers: Record<string, string> = {
      Origin: ORIGIN,
      Cookie: cookie,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${talentumBaseUrl()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(
        `[TalentumApiClient] ${method} ${path} — HTTP ${res.status}: ${errorBody}${errorHint(res.status)}`
      );
    }

    // DELETE e 204 (PATCH) não devolvem corpo.
    if (method === 'DELETE' || res.status === 204) {
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  // ── ITalentumApiClient implementation ───────────────────────────

  /**
   * Cria o projeto v2: POST /projects → PATCH /prescreening (WEB + perguntas) → PUT job-description
   * → complete-submodule PRESCREENING → POST /init (DRAFT → IN_PROGRESS, link vivo), e relê o prescreening para obter o `publicId`. Em qualquer falha DEPOIS do POST apaga o projeto
   * recém-criado (nunca deixa órfão na Talentum) e relança o erro original.
   * `input.faq` é IGNORADO: a v2 não tem FAQ (decisão (g) — a FAQ fica só no nosso banco).
   */
  async createPrescreening(input: CreatePrescreeningInput): Promise<CreatePrescreeningResult> {
    const { projectId } = await this.request<{ projectId: string }>('POST', '/projects', {
      name: toV2ProjectName(input.title),
      type: 'FULL',
      campaigns: 'MANUAL',
      prescreening: true,
    });

    try {
      await this.request<void>('PATCH', `/projects/${projectId}/prescreening`, {
        title: toV2ProjectName(input.title),
        type: 'WEB',
        showJobDescription: true,
        askForCv: input.askForCv ?? false,
        cvRequired: input.cvRequired ?? false,
        askCuit: false,
        language: 'spanish',
        webForm: { askEmail: true, askPhone: true },
        questions: input.questions.map(toV2Question),
      });
      await this.request<unknown>('PUT', `/projects/${projectId}/prescreening/job-description`, {
        text: input.description,
      });
      // Publica: completa o submódulo (como o wizard) e `init` tira o projeto de DRAFT → IN_PROGRESS.
      // Sem o `init` o link público fica "Enlace no válido" (provado na v2 real, spec 040 §P5). Projeto
      // sem fonte de candidatos nem campanha: o `init` só torna o link acessível, não contata ninguém.
      await this.request<void>('POST', `/projects/${projectId}/complete-submodule`, { submodule: 'PRESCREENING' });
      await this.request<void>('POST', `/projects/${projectId}/init`);
      const prescreening = await this.request<{ publicId: string }>('GET', `/projects/${projectId}/prescreening`);
      return { projectId, publicId: prescreening.publicId };
    } catch (err) {
      await this.deletePrescreening(projectId).catch((delErr: unknown) => {
        console.error(
          `[TalentumApiClient] rollback FALHOU — projeto órfão na Talentum v2: ${projectId} (${
            delErr instanceof Error ? delErr.message : String(delErr)
          })`,
        );
      });
      throw err;
    }
  }

  /**
   * Compõe `GET /projects/:id` (nome, status) + `GET /projects/:id/prescreening` (publicId, perguntas,
   * descrição em `jobDescription.text`). `whatsappUrl` leva o LINK WEB derivado do `publicId` (o nome do
   * campo fica por compatibilidade — decisão (a)). `faq` é sempre [] (a v2 não tem).
   */
  async getPrescreening(projectId: string): Promise<TalentumProject> {
    const { project } = await this.request<{ project: V2ProjectListItem }>('GET', `/projects/${projectId}`);
    const p = await this.request<{
      publicId: string;
      slug: string;
      active: boolean;
      timestamp: string;
      jobDescription?: { text: string };
      questions?: Array<Omit<TalentumQuestionWithId, 'desiredResponse'> & { idealResponse: string }>;
    }>('GET', `/projects/${projectId}/prescreening`);

    return {
      projectId,
      publicId: p.publicId,
      title: project.name,
      description: p.jobDescription?.text ?? '',
      whatsappUrl: buildPublicPrescreeningUrl(p.publicId),
      slug: p.slug,
      active: p.active,
      timestamp: p.timestamp,
      questions: (p.questions ?? []).map((q) => ({
        questionId: q.questionId,
        question: q.question,
        type: 'text' as const,
        responseType: q.responseType,
        desiredResponse: q.idealResponse,
        weight: q.weight,
        required: q.required,
        analyzed: q.analyzed,
        earlyStoppage: q.earlyStoppage,
      })),
      faq: [],
      status: project.status,
      type: project.type,
      myRole: project.myRole,
    };
  }

  /**
   * Edita in-place: PATCH /prescreening (título + perguntas, `questionId` mantém a identidade) e
   * PUT /prescreening/job-description (texto — o PATCH rejeita `jobDescription`). `faq` ignorado (g).
   * O PATCH EXIGE `type` (400 "type must be one of: WHATSAPP, SMS, WEB" sem ele — provado na v2 real).
   */
  async updatePrescreening(projectId: string, input: UpdatePrescreeningInput): Promise<void> {
    await this.request<void>('PATCH', `/projects/${projectId}/prescreening`, {
      title: toV2ProjectName(input.title),
      type: 'WEB',
      questions: input.questions.map(toV2Question),
    });
    await this.request<unknown>('PUT', `/projects/${projectId}/prescreening/job-description`, {
      text: input.description,
    });
  }

  async deletePrescreening(projectId: string): Promise<void> {
    return this.request<void>('DELETE', `/projects/${projectId}`);
  }

  /**
   * Uma página de `GET /projects` (12 por página). O item da lista NÃO traz `publicId`,
   * descrição nem perguntas: vêm vazios (use `getPrescreening` para o detalhe).
   */
  async listPrescreenings(
    opts?: ListPrescreeningsOpts,
  ): Promise<{ projects: TalentumProject[]; count: number }> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.onlyOwnedByUser != null) params.set('onlyOwnedByUser', String(opts.onlyOwnedByUser));
    const qs = params.toString();
    const { projects, count } = await this.request<{ projects: V2ProjectListItem[]; count: number }>(
      'GET',
      `/projects${qs ? `?${qs}` : ''}`,
    );

    return {
      count,
      projects: projects.map((item) => ({
        projectId: item._id,
        publicId: '',
        title: item.name,
        description: '',
        whatsappUrl: '',
        slug: '',
        active: item.status === 'IN_PROGRESS',
        timestamp: '',
        questions: [],
        faq: [],
        status: item.status,
        type: item.type,
        myRole: item.myRole,
      })),
    };
  }

  /** Percorre as páginas até alcançar `count` (ou até uma página vazia). */
  async listAllPrescreenings(): Promise<TalentumProject[]> {
    const all: TalentumProject[] = [];
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { projects, count } = await this.listPrescreenings({ page, onlyOwnedByUser: false });
      if (projects.length === 0) break;
      all.push(...projects);
      if (all.length >= count) break;
      page++;
    }

    console.log(`[TalentumApiClient] listAllPrescreenings: fetched ${all.length} projects in ${page} pages`);
    return all;
  }

  // ── Candidatos (v2) ────────────────────────────────────────────

  /** `GET /projects/:id/prescreening/candidates?page=N` — traz telefone, NÃO traz e-mail. */
  async listCandidates(projectId: string, page: number): Promise<TalentumCandidatesPage> {
    return this.request<TalentumCandidatesPage>('GET', `/projects/${projectId}/prescreening/candidates?page=${page}`);
  }

  /** `GET /projects/:id/ready-for-interview?page=N` — só qualificados, mas com e-mail. */
  async listReadyForInterview(projectId: string, page: number): Promise<TalentumCandidatesPage> {
    return this.request<TalentumCandidatesPage>('GET', `/projects/${projectId}/ready-for-interview?page=${page}`);
  }
}
