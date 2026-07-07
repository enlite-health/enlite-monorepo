/**
 * AdminContactNotesApiService
 *
 * CRUD de notas de contato ESCOPADAS À VAGA (vacancyId) — uma única thread
 * por vaga, mostrada IDÊNTICA em todos os cards do Kanban (bloqueado ou não,
 * qualquer coluna, qualquer candidato). Não é mais chaveado por worker.
 * Extraído do AdminApiService para respeitar o limite de 400 linhas —
 * callers continuam usando `AdminApiService` (delega transparentemente).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { ContactNote, CreateContactNotePayload } from '@domain/entities/ContactNote';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminContactNotesApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json()) as ApiResponse<T>;
    if (!json.success) {
      throw new Error(
        (json as ApiErrorResponse).error || `HTTP ${response.status}`,
      );
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  async getContactNotes(vacancyId: string): Promise<ContactNote[]> {
    return this.request<ContactNote[]>(
      'GET',
      `/api/admin/vacancies/${vacancyId}/contact-notes`,
    );
  }

  async createContactNote(
    vacancyId: string,
    payload: CreateContactNotePayload,
  ): Promise<ContactNote> {
    return this.request<ContactNote>(
      'POST',
      `/api/admin/vacancies/${vacancyId}/contact-notes`,
      payload,
    );
  }

  async deleteContactNote(vacancyId: string, noteId: string): Promise<void> {
    await this.request<{ id: string }>(
      'DELETE',
      `/api/admin/vacancies/${vacancyId}/contact-notes/${noteId}`,
    );
  }
}

export const AdminContactNotesApiService =
  new AdminContactNotesApiServiceClass();
