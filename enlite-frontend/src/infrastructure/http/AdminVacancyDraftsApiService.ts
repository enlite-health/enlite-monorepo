/**
 * AdminVacancyDraftsApiService
 *
 * Handles draft-vacancy lookup:
 *   - GET /api/admin/vacancies/in-progress?patient_id=:uuid
 *
 * Kept as a separate sub-service to avoid pushing AdminApiService over the
 * 400-line limit.
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { VacancyDraftSummary } from '@domain/entities/VacancyDraft';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminVacancyDraftsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, { method, headers });
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  async listDraftsForPatient(patientId: string): Promise<VacancyDraftSummary[]> {
    return this.request<VacancyDraftSummary[]>(
      'GET',
      `/api/admin/vacancies/in-progress?patient_id=${encodeURIComponent(patientId)}`,
    );
  }
}

export const AdminVacancyDraftsApiService = new AdminVacancyDraftsApiServiceClass();
