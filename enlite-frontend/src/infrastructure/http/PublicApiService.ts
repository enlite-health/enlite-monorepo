import type { PublicVacancyDetail } from '@domain/entities/Vacancy';
import type { PublicJobListing } from '@domain/entities/PublicJobListing';

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success: false;
  error: string;
}

type ApiResponse<T> = ApiSuccess<T> | ApiError;

/**
 * Filtros opcionais para /api/public/v1/jobs.
 * TD-013: shape alinhado com PublicJobsFiltersSchema do worker-functions
 * (domain/PublicJobsFilters.ts). Mantém em sync via revisão.
 */
export interface PublicJobsFilters {
  /** Código ISO 3166-1 alpha-2 — default 'AR' no backend se ausente */
  country?: string;
  state?: string;
  city?: string;
  pathology?: string;
  worker_sex?: 'FEMALE' | 'MALE' | 'BOTH';
  worker_type?: string;
  /** Busca textual livre */
  q?: string;
}

class PublicApiServiceClass {
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status === 404) {
      throw new VacancyNotFoundError();
    }

    const json: ApiResponse<T> = await response.json();

    if (!json.success) {
      throw new Error((json as ApiError).error || `HTTP ${response.status}`);
    }

    return (json as ApiSuccess<T>).data;
  }

  /**
   * GET /api/vacancies/:id
   * Returns public vacancy details without authentication.
   * Throws VacancyNotFoundError when the vacancy does not exist.
   */
  async getVacancy(id: string): Promise<PublicVacancyDetail> {
    return this.request<PublicVacancyDetail>(`/api/vacancies/${id}`);
  }

  /**
   * GET /api/public/v1/jobs
   * Returns public job listings without authentication.
   *
   * TD-013: filters opcionais. Sem filtros → backend usa default country='AR'.
   * Workers de outros países devem passar country explicitamente.
   */
  async getPublicJobs(filters?: PublicJobsFilters): Promise<PublicJobListing[]> {
    const path = filters ? `/api/public/v1/jobs?${buildQueryString(filters)}` : '/api/public/v1/jobs';
    return this.request<PublicJobListing[]>(path);
  }
}

function buildQueryString(filters: PublicJobsFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

export class VacancyNotFoundError extends Error {
  constructor() {
    super('Vacancy not found');
    this.name = 'VacancyNotFoundError';
  }
}

export const PublicApiService = new PublicApiServiceClass();
