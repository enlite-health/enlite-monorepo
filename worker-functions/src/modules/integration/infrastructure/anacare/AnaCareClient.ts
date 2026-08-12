/**
 * AnaCareClient — implementação HTTP da porta IAnaCareApiClient.
 *
 * Auth: header X-Agency-Key com a chave completa (ana_care.<public>.<secret>).
 * Base URL: ANACARE_BASE_URL (default https://admin.ana.care).
 *
 * Fábricas (mesmo padrão de TalentumApiClient):
 *   fromEnv()         — usa ANACARE_API_KEY (local/dev)
 *   fromSecretManager() — busca secret 'anacare-api-key' no GCP Secret Manager (prod)
 *   create()          — preferencial: env quando presente, SM caso contrário
 */

import type {
  IAnaCareApiClient,
  AnaCareNursePayload,
  AnaCareNurse,
  AnaCareNurseType,
  AnaCareHiringType,
  AnaCarePagedResponse,
  AnaCareNurseBulkPayload,
} from '../../domain/IAnaCareApiClient';
import { logger } from '@shared/logging';

const DEFAULT_BASE_URL = 'https://admin.ana.care';
const SECRET_NAME = 'anacare-api-key';
const TAG = '[AnaCareClient]';

/**
 * Erro tipado de resposta HTTP não-ok da API AnaCare.
 * Carrega status + corpo cru para permitir tratamento estrutural (ex: detectar
 * conflito de unicidade em telefone/email) sem parsear a mensagem de texto.
 */
export class AnaCareApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${TAG} ${method} ${path} — HTTP ${status}: ${body}`);
    this.name = 'AnaCareApiError';
    this.status = status;
    this.body = body;
  }
}

export class AnaCareClient implements IAnaCareApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  // ── Static factories ─────────────────────────────────────────────

  /** Usa ANACARE_API_KEY do ambiente. Intencionado para dev/test. */
  static fromEnv(): AnaCareClient {
    const apiKey = process.env.ANACARE_API_KEY;
    const baseUrl = process.env.ANACARE_BASE_URL;
    if (!apiKey) {
      throw new Error(
        `${TAG} fromEnv: ANACARE_API_KEY must be set`,
      );
    }
    return new AnaCareClient(apiKey, baseUrl);
  }

  /** Busca a API key no GCP Secret Manager. Para produção (Cloud Run). */
  static async fromSecretManager(): Promise<AnaCareClient> {
    // Dynamic require mantém o GCP SDK fora do bundle de teste quando não usado.
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

    const [res] = await client.accessSecretVersion({
      name: `projects/${project}/secrets/${SECRET_NAME}/versions/latest`,
    });

    const apiKey = res.payload?.data?.toString();
    if (!apiKey) {
      throw new Error(`${TAG} fromSecretManager: secret '${SECRET_NAME}' returned empty value`);
    }

    const baseUrl = process.env.ANACARE_BASE_URL;
    return new AnaCareClient(apiKey, baseUrl);
  }

  /**
   * Fábrica preferencial: usa env var quando disponível (local/test),
   * cai no Secret Manager em produção.
   */
  static async create(): Promise<AnaCareClient> {
    if (process.env.ANACARE_API_KEY) {
      return AnaCareClient.fromEnv();
    }
    return AnaCareClient.fromSecretManager();
  }

  // ── Private helper ───────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-Agency-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new AnaCareApiError(method, path, res.status, errorBody);
    }

    // 204 No Content ou body vazio
    const text = await res.text();
    if (!text) return undefined as unknown as T;

    return JSON.parse(text) as T;
  }

  // ── IAnaCareApiClient implementation ────────────────────────────

  async listNurseTypes(): Promise<AnaCarePagedResponse<AnaCareNurseType>> {
    logger.debug({ msg: `${TAG} listNurseTypes` });
    return this.request<AnaCarePagedResponse<AnaCareNurseType>>(
      'GET', '/api/v2/agencies/nurse-types/',
    );
  }

  async listHiringTypes(): Promise<AnaCarePagedResponse<AnaCareHiringType>> {
    logger.debug({ msg: `${TAG} listHiringTypes` });
    return this.request<AnaCarePagedResponse<AnaCareHiringType>>(
      'GET', '/api/v2/agencies/hiring-types/',
    );
  }

  async listNurses(page = 1): Promise<AnaCarePagedResponse<AnaCareNurse>> {
    return this.request<AnaCarePagedResponse<AnaCareNurse>>(
      'GET', `/api/v2/agencies/nurses/?page=${page}`,
    );
  }

  async createNurse(payload: AnaCareNursePayload): Promise<AnaCareNurse> {
    return this.request<AnaCareNurse>('POST', '/api/v2/agencies/nurses/', payload);
  }

  async getNurse(id: number): Promise<AnaCareNurse> {
    return this.request<AnaCareNurse>('GET', `/api/v2/agencies/nurses/${id}/`);
  }

  async updateNurse(id: number, payload: Partial<AnaCareNursePayload>): Promise<AnaCareNurse> {
    return this.request<AnaCareNurse>('PATCH', `/api/v2/agencies/nurses/${id}/`, payload);
  }

  async bulkUpdateNurses(payload: AnaCareNurseBulkPayload): Promise<AnaCareNurse[]> {
    return this.request<AnaCareNurse[]>('PATCH', '/api/v2/agencies/nurses/bulk/', payload);
  }
}
