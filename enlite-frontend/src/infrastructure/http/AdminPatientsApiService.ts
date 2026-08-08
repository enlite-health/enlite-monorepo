/**
 * AdminPatientsApiService
 *
 * Handles patient listing, stats and detail for the admin panel.
 * Extracted from AdminApiService to keep each file under the 400-line limit.
 * Callers use `AdminApiService` — it delegates here transparently.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  PatientDetail,
  PatientVacancySummary,
  CreatePatientPayload,
  CreatePatientResult,
  PatientSectionName,
  PatientSectionPayload,
  UpdatePatientStatusResult,
  ActivatePatientResult,
  PatientKanbanItem,
  PatientFunnelData,
  PatientChatIdsPayload,
  PatientChatCandidatesResult,
} from '@domain/entities/PatientDetail';

/**
 * Error thrown by the pipeline mutations (section edit / status / activate) that
 * carries the HTTP status so callers can branch on it — e.g. 422 (no active
 * address) shows a specific inline message instead of the generic one.
 */
export class PatientApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PatientApiError';
    this.status = status;
  }
}

export interface PatientListFilters {
  search?: string;
  needs_attention?: string;
  attention_reason?: string;
  clinical_specialty?: string;
  dependency_level?: string;
  case_number?: string;
  /** Fase 4 — country scope: 'AR' | 'BR' (omit for all). */
  country?: string;
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

  /** GET /api/admin/patients/stats — `country` opcional escopa por país (AR|BR). */
  async getPatientStats(params?: { country?: string }): Promise<PatientStats> {
    const country = params?.country;
    const qs = country ? `?country=${encodeURIComponent(country)}` : '';
    return this.request<PatientStats>('GET', `/api/admin/patients/stats${qs}`);
  }

  async getPatientById(id: string): Promise<PatientDetail> {
    return this.request<PatientDetail>('GET', `/api/admin/patients/${id}`);
  }

  async getPatientVacancies(patientId: string): Promise<PatientVacancySummary[]> {
    return this.request<PatientVacancySummary[]>('GET', `/api/admin/patients/${patientId}/vacancies`);
  }

  /**
   * POST /api/admin/patients — manual creation of a native patient.
   * The base `request` helper is GET-only, so this issues its own POST with the
   * JSON body. Surfaces the backend's clear 400 message (e.g. contact-channel
   * invariant) as the thrown Error, so the modal can show it inline.
   */
  async createPatient(payload: CreatePatientPayload): Promise<CreatePatientResult> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/patients`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json: ApiResponse<CreatePatientResult> = await response.json();
    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<CreatePatientResult>).data;
  }

  /**
   * Shared writer for the pipeline mutations. The base `request` helper is
   * GET-only, so this issues its own method+body and throws a `PatientApiError`
   * (carrying the HTTP status) on failure so callers can branch on 422/404.
   */
  private async writeJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new PatientApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new PatientApiError((json as ApiErrorResponse).error || `HTTP ${response.status}`, response.status);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  /** PATCH /api/admin/patients/:id/:section — section-scoped partial edit. */
  async updatePatientSection(
    id: string,
    section: PatientSectionName,
    data: PatientSectionPayload,
  ): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('PATCH', `/api/admin/patients/${id}/${section}`, data);
  }

  /**
   * GET /api/admin/patients/:id/chat-candidates — grupos do Periskope parecidos
   * com o nome do paciente. Só leitura; RANQUEIA, nunca escolhe. 503 quando o
   * kill-switch PATIENT_CHAT_LOOKUP_ENABLED está desligado.
   */
  async getPatientChatCandidates(id: string, limit?: number): Promise<PatientChatCandidatesResult> {
    const qs = limit ? `?limit=${limit}` : '';
    return this.writeJson<PatientChatCandidatesResult>(
      'GET', `/api/admin/patients/${id}/chat-candidates${qs}`,
    );
  }

  /**
   * PUT /api/admin/patients/:id/chat-ids — vincula os grupos ao paciente, por
   * papel. `null` desvincula; papel ausente do mapa fica inalterado.
   */
  async updatePatientChatIds(
    id: string,
    payload: PatientChatIdsPayload,
  ): Promise<PatientChatIdsPayload & { id: string }> {
    return this.writeJson<PatientChatIdsPayload & { id: string }>(
      'PUT', `/api/admin/patients/${id}/chat-ids`, payload,
    );
  }

  /** PUT /api/admin/patients/:id/status — kanban lifecycle move. */
  async updatePatientStatus(id: string, status: string): Promise<UpdatePatientStatusResult> {
    return this.writeJson<UpdatePatientStatusResult>('PUT', `/api/admin/patients/${id}/status`, { status });
  }

  /**
   * POST /api/admin/patients/:id/activate — approve → one draft vacancy per
   * active location + move to ACTIVE. Idempotent (already-ACTIVE → []).
   * Throws PatientApiError with status 422 when the patient has no active address.
   */
  async activatePatient(id: string): Promise<ActivatePatientResult> {
    return this.writeJson<ActivatePatientResult>('POST', `/api/admin/patients/${id}/activate`);
  }

  /**
   * Fetch a large page of patients for the kanban board. Reuses the same list
   * endpoint as the table; the board groups the rows by status client-side.
   * Fase 4: forwards the optional `country` scope and maps the additive SLA
   * fields (stageEnteredAt/hoursInStage/slaBreached/slaThresholdHours).
   */
  async listPatientsForKanban(country?: string): Promise<PatientKanbanItem[]> {
    const { data } = await this.listPatients({ limit: '500', offset: '0', country });
    return (data ?? []).map((p: any): PatientKanbanItem => ({
      id: p.id,
      firstName: p.firstName ?? null,
      lastName: p.lastName ?? null,
      caseNumber: p.caseNumber ?? null,
      dependencyLevel: p.dependencyLevel ?? null,
      status: p.status ?? null,
      stageEnteredAt: p.stageEnteredAt ?? null,
      hoursInStage: p.hoursInStage ?? null,
      slaBreached: p.slaBreached ?? false,
      slaThresholdHours: p.slaThresholdHours ?? null,
    }));
  }

  /**
   * Fase 4 — GET /api/admin/patients/funnel. Traceability aggregate scoped by
   * country and date window. `request` unwraps `{ success, data }`.
   */
  async getPatientFunnel(params?: {
    country?: string;
    from?: string;
    to?: string;
  }): Promise<PatientFunnelData> {
    const clean = Object.fromEntries(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== ''),
    );
    const qs = new URLSearchParams(clean as Record<string, string>).toString();
    return this.request<PatientFunnelData>('GET', `/api/admin/patients/funnel${qs ? `?${qs}` : ''}`);
  }
}

export const AdminPatientsApiService = new AdminPatientsApiServiceClass();
