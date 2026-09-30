/**
 * AdminContractedServicesApiService — CRUD do serviço contratado (spec 013, bloco C).
 * Extraído para arquivo próprio: AdminPatientsApiService.ts e AdminApiService.ts já batem no
 * teto de 400 linhas do validador (`AdminApiService` delega, molde `listWorkers`).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  PatientContractedServiceDetail,
  CreateContractedServiceBody,
  UpdateContractedServiceBody,
} from '@domain/entities/PatientContractedService';
import type { PatientKanbanServiceSummary } from '@domain/entities/PatientLifecycle';
import type {
  ItineraryAbsenceResult,
  ServiceTeam,
  ServiceTeamMember,
  ServiceTeamContact,
  RegisterServiceTeamContactBody,
} from '@domain/entities/ServiceTeam';
import type { ItineraryOverlapDetail, PatientItinerary, PatientItineraryEventsResult } from '@domain/entities/PatientItinerary';

export class ContractedServiceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  /** Só no 409 `ITINERARY_OVERLAP` (Fase 12, DX-12.6): os 2 horários em conflito, vindos da API. */
  readonly overlap?: ItineraryOverlapDetail;

  constructor(message: string, status: number, body?: Partial<Omit<ApiErrorResponse, 'success' | 'error'>>) {
    super(message);
    this.name = 'ContractedServiceApiError';
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
    if (body?.existing && body.requested) {
      this.overlap = {
        existing: body.existing,
        requested: body.requested,
        sameAddress: body.sameAddress ?? false,
        minGapMinutes: body.minGapMinutes ?? null,
      };
    }
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
  /** Corpo do 409 `ITINERARY_OVERLAP` (`AdminItineraryWriteController`) — campos no topo do corpo. */
  existing?: ItineraryOverlapDetail['existing'];
  requested?: ItineraryOverlapDetail['requested'];
  sameAddress?: boolean;
  minGapMinutes?: number | null;
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
   * GET /api/admin/patients/:id/itinerary (Fase 12, DX-12.6) — o itinerário do paciente: serviços,
   * slots e alocações com `allocationId`/`displayName`. Uma chamada por montagem da aba.
   */
  async getItinerary(patientId: string): Promise<PatientItinerary> {
    return this.request<PatientItinerary>('GET', `/api/admin/patients/${patientId}/itinerary`);
  }

  /**
   * GET .../itinerary/events?from&to&serviceId&workerId (D445.3) — "Próximos eventos/Substitución":
   * faixa × datas com alocação vigente e ausência sobreposta. `serviceId`/`workerId` filtram;
   * omitidos, traz o patient inteiro. 400 `ITINERARY_EVENTS_RANGE_INVALID` quando o intervalo
   * excede o teto do backend — o chamador decide como reagir (nunca intervalo maior que 62 dias).
   */
  async getItineraryEvents(
    patientId: string,
    from: string,
    to: string,
    filters: { serviceId?: string; workerId?: string } = {},
  ): Promise<PatientItineraryEventsResult> {
    const params = new URLSearchParams({ from, to });
    if (filters.serviceId) params.set('serviceId', filters.serviceId);
    if (filters.workerId) params.set('workerId', filters.workerId);
    return this.request<PatientItineraryEventsResult>('GET', `/api/admin/patients/${patientId}/itinerary/events?${params.toString()}`);
  }

  /**
   * POST .../itinerary/allocations/:allocationId/replace (D445.5) — reemplazo permanente: encerra
   * o titular em D-1 e cria o novo a partir de `fromDate`, 1 transação. 409 `ITINERARY_OVERLAP` /
   * 422 `REPLACEMENT_DATE_IN_PAST`/`NOT_SELECTED_FOR_SERVICE` viram `ContractedServiceApiError`.
   */
  async replaceAllocation(
    patientId: string,
    serviceId: string,
    allocationId: string,
    newWorkerId: string,
    fromDate: string,
  ): Promise<ItineraryReplaceResult> {
    return this.request<ItineraryReplaceResult>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/replace`,
      { newWorkerId, fromDate },
    );
  }

  /** GET .../contracted-services/:sid/allocation-options — os selecionados do serviço, alocáveis. */
  async getAllocationOptions(patientId: string, serviceId: string): Promise<AllocationOptionsResult> {
    return this.request<AllocationOptionsResult>(
      'GET',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/allocation-options`,
    );
  }

  /**
   * POST .../itinerary/slots/:slotId/allocations — aloca o prestador no slot. 201 com a alocação;
   * 409 `ITINERARY_OVERLAP` traz `err.overlap` (os 2 horários); 422 vira `err.code`.
   */
  async allocate(
    patientId: string,
    serviceId: string,
    slotId: string,
    workerId: string,
  ): Promise<ItineraryAllocationResult> {
    return this.request<ItineraryAllocationResult>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`,
      { workerId },
    );
  }

  /**
   * POST .../itinerary/allocations/:allocationId/absences (DX-13.7/13.8) — registra a ausência
   * pontual do titular naquela faixa/data; `substituteWorkerId` omitido = sem substituto (dia
   * fica como alerta). 201 quando criada; 404/422/409 viram `ContractedServiceApiError` (o
   * `code` diz qual: `NOT_SELECTED_FOR_SERVICE`, `SUBSTITUTE_IS_TITULAR`, `ITINERARY_OVERLAP`, …).
   */
  async registerAbsence(
    patientId: string,
    serviceId: string,
    allocationId: string,
    body: { date: string; substituteWorkerId?: string; reasonCategory: string },
  ): Promise<ItineraryAbsenceResult> {
    return this.request<ItineraryAbsenceResult>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/absences`,
      body,
    );
  }

  /**
   * PATCH .../itinerary/absences/:absenceId/substitute (DX-13.7/13.8) — troca ou TIRA o
   * substituto. A chave `substituteWorkerId` é sempre enviada (nunca omitida): `null` explícito
   * tira o substituto (memória `vazio-ambiguo-nao-e-informacao-de-ausencia` — corpo sem a chave
   * seria 400 no backend).
   */
  async setAbsenceSubstitute(
    patientId: string,
    serviceId: string,
    absenceId: string,
    substituteWorkerId: string | null,
  ): Promise<ItineraryAbsenceResult> {
    return this.request<ItineraryAbsenceResult>(
      'PATCH',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/absences/${absenceId}/substitute`,
      { substituteWorkerId },
    );
  }

  /**
   * POST .../itinerary/absences/:absenceId/cancel (DX-13.7/13.8) — cancela a ausência (log,
   * nunca `DELETE`); 422 `ABSENCE_CANCELLED` se já cancelada.
   */
  async cancelAbsence(patientId: string, serviceId: string, absenceId: string): Promise<ItineraryAbsenceResult> {
    return this.request<ItineraryAbsenceResult>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/absences/${absenceId}/cancel`,
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

  /**
   * GET .../team/:workerId/contact — modal do prestador (rodada 2, decisão D): nome/telefone
   * projetados (célula `worker_contact:read`) + histórico de contato (migration 490). 404 quando
   * o serviço não existe/é de outro paciente/está fora da RLS, OU o prestador nunca foi deste time.
   */
  async getServiceTeamContact(patientId: string, serviceId: string, workerId: string): Promise<ServiceTeamContact> {
    return this.request<ServiceTeamContact>(
      'GET',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/team/${workerId}/contact`,
    );
  }

  /**
   * POST .../team/:workerId/contact — grava um registro de contato (linha NOVA, append-only,
   * nunca reescreve as anteriores); devolve o histórico já recalculado (0 GET extra).
   */
  async registerServiceTeamContact(
    patientId: string,
    serviceId: string,
    workerId: string,
    body: RegisterServiceTeamContactBody,
  ): Promise<ServiceTeamContact> {
    return this.request<ServiceTeamContact>(
      'POST',
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/team/${workerId}/contact`,
      body,
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

/** Result of GET .../contracted-services/:sid/allocation-options (Fase 11/12). */
export interface AllocationOptionsResult {
  serviceId: string;
  vacancyId: string | null;
  options: ServiceTeamMember[];
}

/** Result of POST .../itinerary/slots/:slotId/allocations (201). */
export interface ItineraryAllocationResult {
  allocationId: string;
  slotId: string;
  workerId: string;
  applicationId: string;
  validFrom: string;
  status: 'ACTIVE';
}

/** Result of POST .../itinerary/allocations/:allocationId/replace (200, D445.5). */
export interface ItineraryReplaceResult {
  endedAllocationId: string;
  endedValidTo: string;
  newAllocationId: string;
  newWorkerId: string;
  validFrom: string;
  status: 'ACTIVE';
}

export const AdminContractedServicesApiService = new AdminContractedServicesApiServiceClass();
