/**
 * AdminConversationApiService
 *
 * Chat interno por paciente (spec 022, Bloco 2, T205/T206; `contracts/openapi-conversation.md` +
 * `contracts/openapi-staff-directory.md` — leia os dois, são a verdade). Molde:
 * `AdminPatientPhotoApiService.ts` — mesmo `getAuthHeaders`/`requestJson`, mesma forma de
 * `AdminApiService` delegar (T207).
 *
 * `getConversationReplies` desembrulha `{ messages: [...] }` (contrato da rota `.../replies`,
 * `AdminConversationController.listReplies`) e devolve o array puro — a UI (Bloco 2) só precisa da
 * lista, na MESMA forma de item que `getConversation` já devolve.
 *
 * `updateConversationMessage`/`deleteConversationMessage`/`markConversationRead` respondem
 * `{ success: true }` SEM `data` (`AdminConversationController.editMessage/deleteMessage/markRead`)
 * — por isso resolvem `void`, nunca um valor.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export interface ConversationMessageAttachment {
  fileId: string;
  contentType: string;
  sizeBytes: number;
}

export interface ConversationMessage {
  id: string;
  authorUid: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  mentions: string[];
  replyCount: number;
  lastReplyAt: string | null;
  attachments: ConversationMessageAttachment[];
}

export interface ConversationListResult {
  conversationId: string;
  messages: ConversationMessage[];
  nextCursor: string | null;
}

interface ConversationRepliesResponse {
  messages: ConversationMessage[];
}

export interface ConversationListParams {
  /** Cursor `"<created_at ISO>,<uuid>"` — contrato, linha 10. */
  after?: string;
  /** Default 50, max 50 no backend. */
  limit?: number;
}

export interface CreateConversationMessageInput {
  body: string;
  rootMessageId?: string;
  fileIds?: string[];
}

export interface CreateConversationMessageResult {
  id: string;
  createdAt: string;
}

export interface StaffDirectoryEntry {
  uid: string;
  displayName: string;
}

export class AdminConversationApiServiceClass {
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

  // ========== Conversa ==========

  async getConversation(patientId: string, params?: ConversationListParams): Promise<ConversationListResult> {
    const qs = new URLSearchParams();
    if (params?.after) qs.set('after', params.after);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.requestJson<ConversationListResult>('GET', `/api/admin/patients/${patientId}/conversation${query}`);
  }

  async getConversationReplies(patientId: string, messageId: string): Promise<ConversationMessage[]> {
    const result = await this.requestJson<ConversationRepliesResponse>(
      'GET',
      `/api/admin/patients/${patientId}/conversation/messages/${messageId}/replies`,
    );
    return result.messages;
  }

  async postConversationMessage(
    patientId: string,
    input: CreateConversationMessageInput,
  ): Promise<CreateConversationMessageResult> {
    return this.requestJson<CreateConversationMessageResult>(
      'POST',
      `/api/admin/patients/${patientId}/conversation/messages`,
      input,
    );
  }

  async updateConversationMessage(patientId: string, messageId: string, body: string): Promise<void> {
    await this.requestJson<unknown>(
      'PATCH',
      `/api/admin/patients/${patientId}/conversation/messages/${messageId}`,
      { body },
    );
  }

  async deleteConversationMessage(patientId: string, messageId: string): Promise<void> {
    await this.requestJson<unknown>(
      'DELETE',
      `/api/admin/patients/${patientId}/conversation/messages/${messageId}`,
    );
  }

  async markConversationRead(patientId: string): Promise<void> {
    await this.requestJson<unknown>('PUT', `/api/admin/patients/${patientId}/conversation/read-mark`);
  }

  // ========== Diretório de staff (autocomplete de menção) ==========

  async searchStaffDirectory(q: string): Promise<StaffDirectoryEntry[]> {
    return this.requestJson<StaffDirectoryEntry[]>('GET', `/api/admin/staff-directory?q=${encodeURIComponent(q)}`);
  }
}

export const AdminConversationApiService = new AdminConversationApiServiceClass();
