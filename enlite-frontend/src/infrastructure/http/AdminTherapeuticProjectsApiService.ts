/**
 * AdminTherapeuticProjectsApiService — versões do projeto terapêutico e os 3 catálogos (spec 017).
 * Arquivo próprio pelo mesmo motivo do serviço contratado: `AdminApiService` bate no teto de 400 linhas.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  CreateTherapeuticProjectBody,
  TherapeuticCatalogItem,
  TherapeuticCatalogKind,
  TherapeuticProjectVersion,
} from '@domain/entities/TherapeuticProject';

export class TherapeuticProjectApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, body?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'TherapeuticProjectApiError';
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
  }
}

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminTherapeuticProjectsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new TherapeuticProjectApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new TherapeuticProjectApiError(json.error || `HTTP ${response.status}`, response.status, json);
    }
    return json.data;
  }

  /** GET /api/admin/patients/:id/therapeutic-projects — todas as versões, mais recente primeiro. */
  async listVersions(patientId: string): Promise<TherapeuticProjectVersion[]> {
    const { versions } = await this.request<{ versions: TherapeuticProjectVersion[] }>(
      'GET',
      `/api/admin/patients/${patientId}/therapeutic-projects`,
    );
    return versions;
  }

  /**
   * GET /api/admin/patients/:id/therapeutic-projects/:vid — `purpose: 'export'` deixa a trilha
   * `export_pdf` (lex C13): o PDF busca a versão A CADA clique, nunca reusa o que a tela já tinha.
   */
  async getVersion(patientId: string, versionId: string, opts: { purpose?: 'export' } = {}): Promise<TherapeuticProjectVersion> {
    const qs = opts.purpose ? `?purpose=${opts.purpose}` : '';
    return this.request<TherapeuticProjectVersion>('GET', `/api/admin/patients/${patientId}/therapeutic-projects/${versionId}${qs}`);
  }

  /** POST /api/admin/patients/:id/therapeutic-projects — `mode: 'new'` (major+1.0) | `mode: 'edit'` (minor+1). */
  async createVersion(patientId: string, body: CreateTherapeuticProjectBody): Promise<TherapeuticProjectVersion> {
    return this.request<TherapeuticProjectVersion>('POST', `/api/admin/patients/${patientId}/therapeutic-projects`, body);
  }

  /** POST /api/admin/patients/:id/therapeutic-projects/:vid/annul (lex C5). */
  async annulVersion(patientId: string, versionId: string, reason: string): Promise<TherapeuticProjectVersion> {
    return this.request<TherapeuticProjectVersion>('POST', `/api/admin/patients/${patientId}/therapeutic-projects/${versionId}/annul`, { reason });
  }

  /** GET /api/admin/therapeutic-catalogs/<kind> */
  async listCatalog(kind: TherapeuticCatalogKind, opts: { includeInactive?: boolean } = {}): Promise<TherapeuticCatalogItem[]> {
    const qs = opts.includeInactive ? '?includeInactive=true' : '';
    const { items } = await this.request<{ kind: TherapeuticCatalogKind; items: TherapeuticCatalogItem[] }>('GET', `/api/admin/therapeutic-catalogs/${kind}${qs}`);
    return items;
  }

  /** POST /api/admin/therapeutic-catalogs/<kind> */
  async createCatalogItem(kind: TherapeuticCatalogKind, body: { label: string; sortOrder?: number }): Promise<TherapeuticCatalogItem> {
    return this.request<TherapeuticCatalogItem>('POST', `/api/admin/therapeutic-catalogs/${kind}`, body);
  }

  /** PATCH /api/admin/therapeutic-catalogs/<kind>/:itemId — Merge Patch; sem DELETE (soft delete por `active`). */
  async updateCatalogItem(
    kind: TherapeuticCatalogKind,
    itemId: string,
    body: { label?: string; sortOrder?: number; active?: boolean },
  ): Promise<TherapeuticCatalogItem> {
    return this.request<TherapeuticCatalogItem>('PATCH', `/api/admin/therapeutic-catalogs/${kind}/${itemId}`, body);
  }
}

export const AdminTherapeuticProjectsApiService = new AdminTherapeuticProjectsApiServiceClass();
