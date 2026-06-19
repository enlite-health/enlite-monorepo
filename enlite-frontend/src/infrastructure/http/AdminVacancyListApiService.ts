/**
 * AdminVacancyListApiService
 *
 * Handles vacancy listing and filter-options endpoints:
 *   - GET /api/admin/vacancies
 *   - GET /api/admin/vacancies/filter-options
 *
 * Extracted from AdminApiService to keep it under the 400-line limit.
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface VacancyListFilters {
  search?: string;
  client?: string;
  status?: string;
  priority?: string;
  limit?: string;
  offset?: string;
  worker_type?: string;
  state?: string;
  city?: string;
  required_sex?: string;
  /** CSV of day-of-week integers 0–6 (0=domingo). */
  days?: string;
  time_from?: string;
  time_to?: string;
}

export interface VacancyFilterOptions {
  states: string[];
  cities: string[];
}

class AdminVacancyListApiServiceClass {
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

  async listVacancies(
    filters?: VacancyListFilters,
  ): Promise<{ data: unknown[]; total: number }> {
    // Strip undefined / empty-string values to keep the URL clean.
    const clean: Record<string, string> = {};
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && val !== '') {
          clean[key] = val;
        }
      }
    }
    const params = new URLSearchParams(clean);
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies?${params}`,
      { method: 'GET', headers },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data, total: json.total };
  }

  async getVacancyFilterOptions(): Promise<VacancyFilterOptions> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies/filter-options`,
      { method: 'GET', headers },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as VacancyFilterOptions;
  }
}

export const AdminVacancyListApiService = new AdminVacancyListApiServiceClass();
