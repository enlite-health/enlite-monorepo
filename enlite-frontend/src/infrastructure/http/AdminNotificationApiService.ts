/**
 * AdminNotificationApiService
 *
 * Sino de notificações in-app (spec 022, Bloco 4, T409-T413; `contracts/openapi-notifications.md`).
 * Molde: `AdminConversationApiService.ts` — mesmo `getAuthHeaders`/`requestJson`.
 *
 * FR-015 (regra dura): o servidor nunca monta a frase final — devolve ids/nomes resolvidos, o
 * texto (`admin.notifications.mentioned`/`replied`) é montado AQUI, no cliente, por
 * `buildNotificationText`.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export type NotificationTypeCode = 'CONVERSATION_MENTIONED' | 'CONVERSATION_REPLIED';

export interface AdminNotification {
  id: string;
  typeCode: NotificationTypeCode;
  actorUid: string;
  actorDisplayName: string | null;
  patientId: string | null;
  /** `null` se o ATOR do evento perdeu `patient_conversation:read` depois de gerar a notificação
   * (D-13) — a UI mostra "um paciente" nesse caso, nunca esconde a notificação inteira. */
  patientDisplayName: string | null;
  conversationId: string | null;
  messageId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface ListNotificationsParams {
  unreadOnly?: boolean;
  limit?: number;
}

export class AdminNotificationApiServiceClass {
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

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: ApiResponse<T> = await response.json();
    if (!json.success) throw new ApiError(json as ApiErrorResponse, response.status);
    return (json as ApiSuccessResponse<T>).data;
  }

  async listNotifications(params?: ListNotificationsParams): Promise<AdminNotification[]> {
    const qs = new URLSearchParams();
    if (params?.unreadOnly) qs.set('unread', '1');
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.requestJson<AdminNotification[]>('GET', `/api/admin/notifications${query}`);
  }

  async getUnreadCount(): Promise<number> {
    const result = await this.requestJson<{ count: number }>('GET', '/api/admin/notifications/unread-count');
    return result.count;
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.requestJson<unknown>('POST', `/api/admin/notifications/${notificationId}/read`);
  }

  async markAllNotificationsRead(): Promise<number> {
    const result = await this.requestJson<{ updated: number }>('POST', '/api/admin/notifications/read-all');
    return result.updated;
  }
}

export const AdminNotificationApiService = new AdminNotificationApiServiceClass();
