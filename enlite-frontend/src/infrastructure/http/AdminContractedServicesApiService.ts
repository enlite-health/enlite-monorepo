/**
 * AdminContractedServicesApiService — CRUD do serviço contratado (spec 013, bloco C).
 * Extraído para arquivo próprio: AdminPatientsApiService.ts e AdminApiService.ts já batem no
 * teto de 400 linhas do validador (`AdminApiService` delega, molde `listWorkers`).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  PatientContractedServiceDetail,
  PatientContractedServiceProvider,
  CreateContractedServiceBody,
  UpdateContractedServiceBody,
  AssociateProviderBody,
  UpdateProviderBody,
} from '@domain/entities/PatientContractedService';
import type { PatientKanbanServiceSummary } from '@domain/entities/PatientLifecycle';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';

export class ContractedServiceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, body?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'ContractedServiceApiError';
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

class AdminContractedServicesApiServiceClass {
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
      throw new ContractedServiceApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new ContractedServiceApiError(json.error || `HTTP ${response.status}`, response.status, json);
    }
    return json.data;
  }

  /** GET /api/admin/patients/:id/contracted-services */
  async listContractedServices(patientId: string): Promise<PatientContractedServiceDetail[]> {
    const { services } = await this.request<{ services: PatientContractedServiceDetail[] }>(
      'GET',
      `/api/admin/patients/${patientId}/contracted-services`,
    );
    return services;
  }

  /** POST /api/admin/patients/:id/contracted-services */
  async createContractedService(
    patientId: string,
    body: CreateContractedServiceBody,
  ): Promise<PatientContractedServiceDetail> {
    return this.request<PatientContractedServiceDetail>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services`,
      body,
    );
  }

  /** PATCH /api/admin/patients/:id/contracted-services/:sid — Merge Patch; sem DELETE (lex C-a.4). */
  async updateContractedService(
    patientId: string,
    serviceId: string,
    body: UpdateContractedServiceBody,
  ): Promise<PatientContractedServiceDetail> {
    return this.request<PatientContractedServiceDetail>(
      'PATCH',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      body,
    );
  }

  /** POST /api/admin/patients/:id/contracted-services/:sid/providers — associa worker existente. */
  async associateProvider(
    patientId: string,
    serviceId: string,
    body: AssociateProviderBody,
  ): Promise<PatientContractedServiceProvider> {
    return this.request<PatientContractedServiceProvider>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/providers`,
      body,
    );
  }

  /** PATCH .../providers/:pid — weeklyHours e/ou baixa (active:false, sem DELETE — lex C-e.2). */
  async updateProvider(
    patientId: string,
    serviceId: string,
    providerId: string,
    body: UpdateProviderBody,
  ): Promise<PatientContractedServiceProvider> {
    return this.request<PatientContractedServiceProvider>(
      'PATCH',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/providers/${providerId}`,
      body,
    );
  }

  /**
   * POST /api/admin/patients/:id/contracted-services/:sid/activate-recruitment
   * (spec 018, PR-6, ADR-5, `contracts/activation.md`). 201 quando cria a vaga em rascunho;
   * 404/409/422 viram `ContractedServiceApiError` (o `code` diz qual — `NOT_FOUND`,
   * `SERVICE_ALREADY_RECRUITING`, `PATIENT_NOT_READY`).
   */
  async activateRecruitment(patientId: string, serviceId: string): Promise<ActivateRecruitmentResult> {
    return this.request<ActivateRecruitmentResult>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
    );
  }

  /**
   * GET /api/admin/patients/kanban/services — agregado do subcard do Kanban (fase 8, Plano B,
   * DX-8.1). Uma chamada por carga do board, nunca uma por card. `country` reusa o mesmo filtro
   * da listagem — omitido, o backend devolve todos os países que a RLS deixa ver.
   */
  async listKanbanServices(
    country?: string,
  ): Promise<KanbanServicesResult> {
    return this.request<KanbanServicesResult>(
      'GET',
      `/api/admin/patients/kanban/services${country ? `?country=${encodeURIComponent(country)}` : ''}`,
    );
  }

  /**
   * GET /api/admin/patients/:id/contracted-services/:sid/team — o time do quadro C, CALCULADO
   * (DX-10.7). Uma chamada por seleção de linha, nunca por card/coluna (o hook governa isso).
   */
  async getServiceTeam(patientId: string, serviceId: string): Promise<ServiceTeam> {
    return this.request<ServiceTeam>(
      'GET',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/team`,
    );
  }

  /**
   * POST .../team/reject — grava a marca de rejeição; devolve o time já recalculado (0 GET
   * extra). `reasonCategory` ausente é 422 `SERVICE_TEAM_REASON_REQUIRED` — regra da API, o
   * cliente só encaminha (invariante 10, critério 8).
   */
  async rejectServiceTeamMember(
    patientId: string,
    serviceId: string,
    workerId: string,
    reasonCategory?: string,
  ): Promise<ServiceTeam> {
    return this.request<ServiceTeam>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/team/reject`,
      { workerId, reasonCategory },
    );
  }

  /**
   * POST .../team/revert — reverte a rejeição (a tabela é o log: grava `reverted_*`, nunca
   * `DELETE`); devolve o time recalculado. `reasonCategory` ausente é 422
   * `SERVICE_TEAM_REASON_REQUIRED` (invariante 11 — motivo nos dois sentidos).
   */
  async revertServiceTeamMember(
    patientId: string,
    serviceId: string,
    workerId: string,
    reasonCategory?: string,
  ): Promise<ServiceTeam> {
    return this.request<ServiceTeam>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/team/revert`,
      { workerId, reasonCategory },
    );
  }
}

/** Result of POST /:id/contracted-services/:sid/activate-recruitment. */
export interface ActivateRecruitmentResult {
  vacancyId: string;
  patientStatus: string;
  statusChanged: boolean;
}

/** Result of GET /api/admin/patients/kanban/services (fase 8, DX-8.1/8.5). */
export interface KanbanServicesResult {
  patients: Array<{ patientId: string; asOf: string; services: PatientKanbanServiceSummary[] }>;
}

export const AdminContractedServicesApiService = new AdminContractedServicesApiServiceClass();
