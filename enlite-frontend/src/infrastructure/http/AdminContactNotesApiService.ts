/**
 * AdminContactNotesApiService
 *
 * CRUD de notas de contato por candidato (WJA) dentro de uma vacante.
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

  async getContactNotes(
    vacancyId: string,
    wjaId: string,
  ): Promise<ContactNote[]> {
    return this.request<ContactNote[]>(
      'GET',
      `/api/admin/vacancies/${vacancyId}/applications/${wjaId}/contact-notes`,
    );
  }

  async createContactNote(
    vacancyId: string,
    wjaId: string,
    payload: CreateContactNotePayload,
  ): Promise<ContactNote> {
    return this.request<ContactNote>(
      'POST',
      `/api/admin/vacancies/${vacancyId}/applications/${wjaId}/contact-notes`,
      payload,
    );
  }
}

export const AdminContactNotesApiService =
  new AdminContactNotesApiServiceClass();
