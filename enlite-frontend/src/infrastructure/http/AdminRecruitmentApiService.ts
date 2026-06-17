import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { RecruitmentHealthData } from '@domain/entities/RecruitmentHealth';
import type { BlockedAttemptsResponse, BlockedAttemptsFilters } from '@domain/entities/BlockedAttempt';

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await authService.getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${getBaseURL()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json.data;
}

export const AdminRecruitmentApiService = {
  async getClickUpCases(filters?: { startDate?: string; endDate?: string; status?: string }): Promise<any[]> {
    const params = new URLSearchParams(filters as any);
    return request<any[]>('GET', `/api/admin/recruitment/clickup-cases?${params}`);
  },

  async getTalentumWorkers(filters?: { startDate?: string; endDate?: string }): Promise<any[]> {
    const params = new URLSearchParams(filters as any);
    return request<any[]>('GET', `/api/admin/recruitment/talentum-workers?${params}`);
  },

  async getProgresoWorkers(filters?: { startDate?: string; endDate?: string }): Promise<any[]> {
    const params = new URLSearchParams(filters as any);
    return request<any[]>('GET', `/api/admin/recruitment/progreso?${params}`);
  },

  async getPublications(filters?: { startDate?: string; endDate?: string; caseNumber?: string }): Promise<any[]> {
    const params = new URLSearchParams(filters as any);
    return request<any[]>('GET', `/api/admin/recruitment/publications?${params}`);
  },

  async getEncuadres(filters?: { startDate?: string; endDate?: string; caseNumber?: string; resultado?: string }): Promise<any[]> {
    const params = new URLSearchParams(filters as any);
    return request<any[]>('GET', `/api/admin/recruitment/encuadres?${params}`);
  },

  async getGlobalMetrics(filters?: { startDate?: string; endDate?: string }): Promise<any> {
    const params = new URLSearchParams(filters as any);
    return request<any>('GET', `/api/admin/recruitment/global-metrics?${params}`);
  },

  async getCaseAnalysis(caseNumber: string): Promise<any> {
    return request<any>('GET', `/api/admin/recruitment/case/${caseNumber}`);
  },

  async getZoneAnalysis(): Promise<any> {
    return request<any>('GET', '/api/admin/recruitment/zones');
  },

  async calculateReemplazos(): Promise<any> {
    return request<any>('POST', '/api/admin/recruitment/calculate-reemplazos');
  },

  async getRecruitmentHealth(): Promise<RecruitmentHealthData> {
    return request<RecruitmentHealthData>('GET', '/api/admin/recruitment/health');
  },

  async getBlockedAttempts(
    filters: BlockedAttemptsFilters = {},
  ): Promise<BlockedAttemptsResponse> {
    const params = new URLSearchParams();
    if (filters.jobPostingId) params.set('jobPostingId', filters.jobPostingId);
    if (filters.workerId) params.set('workerId', filters.workerId);
    if (filters.reason) params.set('reason', filters.reason);
    if (filters.page !== undefined) params.set('page', String(filters.page));
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    const qs = params.toString();

    const headers = await getAuthHeaders();
    const resp = await fetch(
      `${getBaseURL()}/api/admin/recruitment/blocked-attempts${qs ? `?${qs}` : ''}`,
      { method: 'GET', headers },
    );
    const json = (await resp.json()) as {
      success: boolean;
      data?: BlockedAttemptsResponse['data'];
      aggregates?: BlockedAttemptsResponse['aggregates'];
      pagination?: BlockedAttemptsResponse['pagination'];
      error?: string;
    };
    if (!json.success) throw new Error(json.error ?? `HTTP ${resp.status}`);
    return {
      data: json.data ?? [],
      aggregates: json.aggregates ?? { totalBlocked: 0, byReason: {} },
      pagination: json.pagination ?? {
        total: 0,
        limit: filters.limit ?? 20,
        offset: 0,
        page: 1,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
  },
};
