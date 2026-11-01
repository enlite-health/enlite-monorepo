/**
 * AdminAssistantsApiService — chat with the assistants (spec 080, phase A).
 * Contract: `specs/080-assistentes-no-app/contratos/rotas-gestoras-service.md` (routes of the `assistants-service`,
 * called straight from the browser, no proxy). The base comes from `VITE_ASSISTANTS_SERVICE_URL`, never from the platform's.
 *
 * Success body has NO envelope (`{ assistants }`); `{success:true,data}` is accepted too. `POST …/read` answers 204.
 * Error: `{ success:false, code, message }` → `AssistantError{code,status}`; a status without a known code falls back to
 * the contract's code for that status. 401 `TOKEN_EXPIRED` → ONE retry with a fresh `getIdToken()`, and only one.
 */
import { FirebaseAuthService } from "@infrastructure/services/FirebaseAuthService";
import {
  AssistantError,
  type Assistant,
  type AssistantErrorCode,
  type AssistantMessagesPage,
  type AssistantSendResponse,
} from "@domain/entities/Assistant";

const CODES: readonly AssistantErrorCode[] = [
  "TOKEN_MISSING",
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "NOT_STAFF",
  "NO_REACH",
  "ASSISTANT_UNAVAILABLE",
  "INVALID_FORMAT",
  "PERSON_DAILY_CAP",
  "ASSISTANT_MONTHLY_CAP",
  "MODEL_ERROR",
  "INTERNAL_ERROR",
  "PLATFORM_UNAVAILABLE",
];

const CODE_BY_STATUS: Record<number, AssistantErrorCode> = {
  400: "INVALID_FORMAT",
  401: "TOKEN_INVALID",
  403: "NO_REACH",
  409: "ASSISTANT_UNAVAILABLE",
  429: "PERSON_DAILY_CAP",
  502: "MODEL_ERROR",
  503: "PLATFORM_UNAVAILABLE",
};

/**
 * The service's base: `VITE_ASSISTANTS_SERVICE_URL` (build), never the platform's base URL.
 * Empty = no service configured = NO FETCH (fail-closed): there is no localhost fallback.
 * Pure on purpose: vitest 1.4 does not let a test change the module's `import.meta.env`.
 */
export function resolveAssistantsBaseUrl(
  env: Record<string, string | undefined> | undefined,
): string {
  return env?.VITE_ASSISTANTS_SERVICE_URL?.trim() || "";
}

export interface MessagesParams {
  limit?: number;
  before?: string;
}

export class AdminAssistantsApiServiceClass {
  private readonly authService = new FirebaseAuthService();

  /** `baseUrl` is injectable for tests; by default it is the build's `VITE_ASSISTANTS_SERVICE_URL`. */
  constructor(private readonly baseUrl?: string) {}

  private baseURL(): string {
    return (
      this.baseUrl ??
      resolveAssistantsBaseUrl(
        (import.meta as unknown as { env: Record<string, string> }).env,
      )
    );
  }

  /** One HTTP call with a token fetched right now; the caller decides whether to repeat. */
  private async send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ response: Response; json: Record<string, unknown> }> {
    const base = this.baseURL();
    // Fail-closed: no configured service, no request (the caller sees PLATFORM_UNAVAILABLE).
    if (!base) throw new AssistantError("PLATFORM_UNAVAILABLE", 0);
    const token = await this.authService.getIdToken();
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json =
      response.status === 204
        ? {}
        : ((await response.json().catch(() => ({}))) as Record<string, unknown>);
    return { response, json };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let { response, json } = await this.send(method, path, body);
    if (response.status === 401 && json.code === "TOKEN_EXPIRED") {
      // the only retry: a fresh token, once
      ({ response, json } = await this.send(method, path, body));
    }
    if (!response.ok || json.success === false) {
      const code = typeof json.code === "string" ? json.code : undefined;
      const known = CODES.find((c) => c === code);
      const byStatus = CODE_BY_STATUS[response.status];
      const message =
        typeof json.message === "string" ? json.message : undefined;
      throw new AssistantError(
        known ?? byStatus ?? "UNKNOWN",
        response.status,
        message,
      );
    }
    return (json.success === true && "data" in json ? json.data : json) as T;
  }

  async list(): Promise<Assistant[]> {
    if (!this.baseURL()) return []; // no service configured: no widget, no fetch
    const r = await this.request<{ assistants: Assistant[] }>(
      "GET",
      "/assistants",
    );
    return r.assistants;
  }

  async messages(
    slug: string,
    params: MessagesParams = {},
  ): Promise<AssistantMessagesPage> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.before) qs.set("before", params.before);
    const q = qs.toString() ? `?${qs}` : "";
    return this.request<AssistantMessagesPage>(
      "GET",
      `/assistants/${encodeURIComponent(slug)}/messages${q}`,
    );
  }

  async sendMessage(slug: string, text: string): Promise<AssistantSendResponse> {
    return this.request<AssistantSendResponse>(
      "POST",
      `/assistants/${encodeURIComponent(slug)}/messages`,
      { text },
    );
  }

  /** POST /assistants/:slug/read, no body; 204 is success. */
  async markRead(slug: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/assistants/${encodeURIComponent(slug)}/read`,
    );
  }
}

export const AdminAssistantsApiService = new AdminAssistantsApiServiceClass();
