import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { RecruitmentHealthData } from '@domain/entities/RecruitmentHealth';

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
};
