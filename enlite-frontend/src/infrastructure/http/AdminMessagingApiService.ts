/**
 * AdminMessagingApiService
 *
 * Endpoints de envio WhatsApp + listagem/preview de templates pro admin panel.
 * Extraído do AdminApiService pra respeitar o limite de 400 linhas — callers
 * continuam usando `AdminApiService` (delega transparentemente).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { MessageTemplate, WhatsAppSentResult } from '../../types/match';

export interface WhatsAppPreviewResult {
  body: string;
  renderedBody: string;
  variables: Record<string, string>;
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
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
  }

  async sendWhatsApp(
    workerId: string,
    templateSlug: string,
    variables: Record<string, string>,
    jobPostingId?: string,
  ): Promise<WhatsAppSentResult> {
    return this.request<WhatsAppSentResult>('POST', '/api/admin/messaging/whatsapp', {
      workerId,
      templateSlug,
      variables,
      ...(jobPostingId ? { jobPostingId } : {}),
    });
  }

  /**
   * Renderiza o preview do template aplicando variáveis server-side.
   * `body` = template cru; `renderedBody` = texto final (com PII) que o
   * destinatário vai receber. Mostre `renderedBody` no UI.
   */
  async previewWhatsApp(
    workerId: string,
    templateSlug: string,
    jobPostingId?: string,
  ): Promise<WhatsAppPreviewResult> {
    return this.request<WhatsAppPreviewResult>(
      'POST',
      '/api/admin/messaging/whatsapp/preview',
      { workerId, templateSlug, ...(jobPostingId ? { jobPostingId } : {}) },
    );
  }

  async getMessageTemplates(): Promise<MessageTemplate[]> {
    return this.request<MessageTemplate[]>('GET', '/api/admin/messaging/templates');
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
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<T>).data;
  }
}

export const AdminMessagingApiService = new AdminMessagingApiServiceClass();
