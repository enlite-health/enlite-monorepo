/**
 * AdminPresenceApiService — POST /api/admin/me/presence (heartbeat, spec 022, Rodada 2/R2-F).
 * Molde: `AdminNotificationApiService.ts` — mesmo `getAuthHeaders`.
 *
 * 🔒 Por que NÃO reusa `requestJson` (padrão dos outros clients): a rota devolve 204 SEM corpo no
 * sucesso (`AdminPresenceController.heartbeat`, backend R2-B) — `requestJson` sempre chama
 * `response.json()` e esperaria `{success, data}`, o que quebraria (ou mentiria) num 204 vazio.
 * Erro (401/403/500) continua vindo como JSON `{success:false,...}` — só o caminho de sucesso é
 * diferente.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse } from './ApiError';

export class AdminPresenceApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** 204 sempre que autenticado — o throttle do servidor (regravou `last_seen_at` ou não) é
   * TRANSPARENTE ao cliente (docstring do controller no backend). Best-effort: quem chama
   * (`usePresenceHeartbeat`) decide não deixar a falha virar erro visível — este método só
   * propaga a rejeição, nunca a esconde por conta própria (quem chama decide isso). */
  async heartbeat(): Promise<void> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/me/presence`, {
      method: 'POST',
      headers,
    });
    if (response.ok) return;
    let payload: ApiErrorResponse;
    try {
      payload = await response.json();
    } catch {
      payload = { success: false, error: `HTTP ${response.status}` };
    }
    throw new ApiError(payload, response.status);
  }
}

export const AdminPresenceApiService = new AdminPresenceApiServiceClass();
