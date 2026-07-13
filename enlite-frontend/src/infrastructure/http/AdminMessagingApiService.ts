/**
 * AdminMessagingApiService
 *
 * Endpoint de envio WhatsApp para match de vacancy pro admin panel.
 * O backend decide o slug do template automaticamente com base no workers.status.
 * Extraído do AdminApiService pra respeitar o limite de 400 linhas — callers
 * continuam usando `AdminApiService` (delega transparentemente).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface VacancyMatchInviteResult {
  templateSlug: string;
  externalId: string;
  status: string;
  to: string;
}

/**
 * Códigos com que o backend recusa (HTTP 422) o disparo individual de convite
 * de match. São estáveis e usados como chave de i18n na UI — o `detail` do
 * backend vem em PT-BR e NÃO deve ir cru pra tela (recrutadoras são argentinas).
 */
export const INVITE_BLOCKED_CODES = [
  'OPTED_OUT',
  'COOLDOWN',
  'ALREADY_INVITED',
  'UNANSWERED_THROTTLE',
  'WORKER_STATUS_INVALID',
] as const;
export type InviteBlockedCode = (typeof INVITE_BLOCKED_CODES)[number];

/**
 * Lançado quando o backend responde 422 recusando o convite. Carrega o `code`
 * (para mapear numa mensagem localizada) e o `detail` PT-BR (fallback quando o
 * code é desconhecido pelo frontend).
 */
export class InviteBlockedError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(detail || code);
    this.name = 'InviteBlockedError';
    this.code = code;
    this.detail = detail;
  }
}

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export class AdminMessagingApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
  }

  /**
   * Dispara o convite de match WhatsApp para um worker.
   * O backend resolve automaticamente o template slug (complete vs incomplete)
   * baseado no workers.status — o frontend não precisa escolher.
   */
  async sendVacancyMatchInvite(
    workerId: string,
    jobPostingId: string,
  ): Promise<VacancyMatchInviteResult> {
    return this.request<VacancyMatchInviteResult>(
      'POST',
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId, jobPostingId },
    );
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await response.json() as ApiResponse<T> & { detail?: string };
    // 422 = recusa de negócio (opt-out, cooldown, …). O corpo é
    // `{ error: <CODE>, detail: <PT-BR> }`; propaga como erro tipado para a UI
    // resolver a mensagem localizada a partir do CODE.
    if (response.status === 422 && typeof (json as ApiErrorResponse).error === 'string') {
      throw new InviteBlockedError((json as ApiErrorResponse).error, json.detail);
    }
    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<T>).data;
  }
}

export const AdminMessagingApiService = new AdminMessagingApiServiceClass();
