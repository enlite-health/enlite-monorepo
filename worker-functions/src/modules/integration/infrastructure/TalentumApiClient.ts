/**
 * TalentumApiClient — infrastructure service for the Talentum.chat outbound API.
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
  TalentumDashboardProfile,
  TalentumDashboardResponse,
} from '../domain/ITalentumApiClient';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.production.talentum.chat';
const ORIGIN = 'https://www.talentum.chat';

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
    const res = await fetch(`${BASE_URL}/auth/login`, {
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
   * Returns parsed JSON for GET/POST and void for DELETE (CA-1.7: always includes
   * response body in error messages for easier debugging).
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const cookie = await this.ensureAuth();

    const headers: Record<string, string> = {
      Origin: ORIGIN,
      Cookie: cookie,
    };
    if (method === 'POST' || method === 'PUT') {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(
        `[TalentumApiClient] ${method} ${path} — HTTP ${res.status}: ${errorBody}`
      );
    }

    // DELETE e PUT (204 No Content) não devolvem corpo.
    if (method === 'DELETE' || method === 'PUT' || res.status === 204) {
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  // ── ITalentumApiClient implementation ───────────────────────────

  async createPrescreening(input: CreatePrescreeningInput): Promise<CreatePrescreeningResult> {
    return this.request<CreatePrescreeningResult>('POST', '/pre-screening/projects', {
      ...input,
      type: 'WHATSAPP',
      askForCv: input.askForCv ?? false,
      cvRequired: input.cvRequired ?? false,
      linkedinRequired: input.linkedinRequired ?? false,
    });
  }

  async getPrescreening(projectId: string): Promise<TalentumProject> {
    return this.request<TalentumProject>('GET', `/pre-screening/projects/${projectId}`);
  }

  /**
   * Edita um projeto in-place (PUT → 204). Preserva projectId/whatsappUrl/slug.
   * O schema do PUT difere do create: SEM `type` no top-level, COM `type:'text'`
   * por pergunta (provado contra a Talentum real). `questionId` mantém a identidade
   * das perguntas existentes.
   */
  async updatePrescreening(projectId: string, input: UpdatePrescreeningInput): Promise<void> {
    await this.request<void>('PUT', `/pre-screening/projects/${projectId}`, {
      title: input.title,
      description: input.description,
      faq: input.faq ?? [],
      questions: input.questions.map((q) => ({
        question: q.question,
        type: 'text' as const,
        responseType: q.responseType,
        desiredResponse: q.desiredResponse,
        weight: q.weight,
        required: q.required,
        analyzed: q.analyzed,
        earlyStoppage: q.earlyStoppage,
        ...(q.questionId ? { questionId: q.questionId } : {}),
      })),
    });
  }

  async deletePrescreening(projectId: string): Promise<void> {
    return this.request<void>('DELETE', `/pre-screening/projects/${projectId}`);
  }

  async listPrescreenings(
    opts?: ListPrescreeningsOpts,
  ): Promise<{ projects: TalentumProject[]; count: number }> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.onlyOwnedByUser != null) params.set('onlyOwnedByUser', String(opts.onlyOwnedByUser));
    const qs = params.toString();
    const path = `/pre-screening/projects${qs ? `?${qs}` : ''}`;
    return this.request<{ projects: TalentumProject[]; count: number }>('GET', path);
  }

  async listAllPrescreenings(): Promise<TalentumProject[]> {
    const all: TalentumProject[] = [];
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { projects } = await this.listPrescreenings({
        page,
        onlyOwnedByUser: false,
      });
      if (projects.length === 0) break;
      all.push(...projects);
      page++;
    }

    console.log(`[TalentumApiClient] listAllPrescreenings: fetched ${all.length} projects in ${page - 1} pages`);
    return all;
  }

  // ── Dashboard (candidate profiles) ─────────────────────────────

  async listDashboardProfiles(page: number): Promise<TalentumDashboardResponse> {
    return this.request<TalentumDashboardResponse>('GET', `/dashboard?page=${page}&type=TABLE`);
  }

  async listAllDashboardProfiles(): Promise<TalentumDashboardProfile[]> {
    const all: TalentumDashboardProfile[] = [];
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { profiles } = await this.listDashboardProfiles(page);
      if (profiles.length === 0) break;
      all.push(...profiles);
      page++;
    }

    console.log(`[TalentumApiClient] listAllDashboardProfiles: fetched ${all.length} profiles in ${page - 1} pages`);
    return all;
  }
}
