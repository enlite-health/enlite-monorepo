/**
 * AdminWorkerListApiService
 *
 * Handles worker listing and filter-options endpoints:
 *   - GET /api/admin/workers/case-options
 *   - GET /api/admin/workers/filter-options
 *   - GET /api/admin/workers  (list with filters)
 *
 * Extracted from AdminApiService to keep it under the 400-line limit.
 * Same pattern as AdminVacancyListApiService.
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface WorkerListFilters {
  platform?: string;
  docs_complete?: string;
  docs_validated?: 'all_validated' | 'pending_validation';
  search?: string;
  case_id?: string;
  tag_ids?: string;
  limit?: string;
  offset?: string;
  // profile filters
  profession?: string;
  preferred_age_range?: string;
  experience_type?: string;
  preferred_type?: string;
  language?: string;
  sex?: string;
  state?: string;
  city?: string;
  /** CSV of day-of-week integers 0–6 (0=domingo). */
  days?: string;
}

export interface WorkerFilterOptions {
  states: string[];
  cities: string[];
  experienceTypes: string[];
  preferredTypes: string[];
}

class AdminWorkerListApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as { env?: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async listCaseOptions(): Promise<{ value: string; label: string }[]> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/workers/case-options`, {
      method: 'GET',
      headers,
    });
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return (json.data ?? []) as { value: string; label: string }[];
  }

  async getWorkerFilterOptions(): Promise<WorkerFilterOptions> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/workers/filter-options`, {
      method: 'GET',
      headers,
    });
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as WorkerFilterOptions;
  }

  async listWorkers(filters?: WorkerListFilters): Promise<{ data: unknown[]; total: number }> {
    const clean: Record<string, string> = {};
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && val !== '') {
          clean[key] = val as string;
        }
      }
    }
    const params = new URLSearchParams(clean);
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/workers?${params}`, {
      method: 'GET',
      headers,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data ?? [], total: json.total ?? 0 };
  }
}

export const AdminWorkerListApiService = new AdminWorkerListApiServiceClass();
