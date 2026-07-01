/**
 * AdminPatientsApiService
 *
 * Handles patient listing, stats and detail for the admin panel.
 * Extracted from AdminApiService to keep each file under the 400-line limit.
 * Callers use `AdminApiService` — it delegates here transparently.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { PatientDetail, PatientVacancySummary } from '@domain/entities/PatientDetail';

export interface PatientListFilters {
  search?: string;
  needs_attention?: string;
  attention_reason?: string;
  clinical_specialty?: string;
  dependency_level?: string;
  case_number?: string;
  limit?: string;
  offset?: string;
}

export interface PatientStats {
  total: number;
  complete: number;
  needsAttention: number;
  createdToday: number;
  createdYesterday: number;
  createdLast7Days: number;
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

export class AdminPatientsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
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

  async listPatients(filters?: PatientListFilters): Promise<{ data: any[]; total: number }> {
    const cleanFilters = Object.fromEntries(
      Object.entries(filters ?? {}).filter(([, v]) => v !== undefined && v !== ''),
    );
    const params = new URLSearchParams(cleanFilters as Record<string, string>);
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/patients?${params}`, { method: 'GET', headers });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data ?? [], total: json.total ?? 0 };
  }

  async getPatientStats(): Promise<PatientStats> {
    return this.request<PatientStats>('GET', '/api/admin/patients/stats');
  }

  async getPatientById(id: string): Promise<PatientDetail> {
    return this.request<PatientDetail>('GET', `/api/admin/patients/${id}`);
  }

  async getPatientVacancies(patientId: string): Promise<PatientVacancySummary[]> {
    return this.request<PatientVacancySummary[]>('GET', `/api/admin/patients/${patientId}/vacancies`);
  }
}

export const AdminPatientsApiService = new AdminPatientsApiServiceClass();
