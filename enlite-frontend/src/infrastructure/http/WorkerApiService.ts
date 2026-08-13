import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { DedupFieldComparison } from '@domain/entities/DedupGroup';

/**
 * Discriminated union returned by POST /api/workers/init (Onda 2).
 * - 'ok': worker created/fetched normally
 * - 'claim_pending': a candidate with matching phone was found — OTP verification required
 */
export type InitWorkerResponse =
  | { status: 'ok'; worker: WorkerProgressResponse }
  | { status: 'claim_pending'; candidateWorkerId: string; phoneMasked: string; verificationSid: string };

/** Shape returned by GET /api/workers/me */
export interface WorkerProgressResponse {
  id: string;
  authUid: string;
  email: string;
  phone?: string;
  whatsappPhone?: string;
  lgpdConsentAt?: string;
  status?: string;
  country: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  sex?: string;
  gender?: string;
  documentType?: string;
  documentNumber?: string;
  languages?: string[];
  profession?: string;
  knowledgeLevel?: string;
  experienceTypes?: string[];
  yearsExperience?: string;
  preferredTypes?: string[];
  preferredAgeRange?: string[];
  titleCertificate?: string;
  profilePhotoUrl?: string;
  serviceAddress?: string;
  serviceAddressComplement?: string;
  serviceCity?: string;
  serviceState?: string;
  serviceCountry?: string;
  servicePostalCode?: string;
  serviceNeighborhood?: string;
  serviceRadiusKm?: number;
  serviceLat?: number;
  serviceLng?: number;
  acceptsRemoteService?: boolean;
  availability?: Record<string, unknown>;
}

/** Shape returned by GET /api/workers/me/availability */
export interface AvailabilitySlotResponse {
  id: string;
  workerId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  crossesMidnight: boolean;
}

/** Payload for POST /api/workers/init */
export interface InitWorkerPayload {
  authUid: string;
  email: string;
  phone?: string;
  whatsappPhone?: string;
  lgpdOptIn?: boolean;
  country?: string;
}

/** Payload for PUT /api/workers/step */
export interface SaveStepPayload {
  workerId: string;
  step: number;
  data: Record<string, any>;
}

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  reason?: string;
  workerStatus?: string | null;
  missingFields?: string[];
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Shape returned by GET /api/workers/lookup (public, no auth) */
export interface WorkerLookupResponse {
  found: boolean;
  phoneMasked?: string;
}

// ── Account link (vínculo self-service por colisão de telefone) ─────────────
// Contrato v2: lookup SEM SMS e só mascarados; OTP dispara no start (intenção
// explícita); valores de conflito só DEPOIS da posse provada (confirm).

/** POST /api/workers/me/account-link/lookup */
export interface AccountLinkLookupResponse {
  otherEmailMasked: string;
  phoneMasked: string;
}

/** POST /api/workers/me/account-link/start */
export interface AccountLinkStartResponse {
  verificationSid: string;
  phoneMasked: string;
}

/** Conflito com sugestão do servidor (conta com updated_at mais recente). */
export interface AccountLinkConflict extends DedupFieldComparison {
  suggested: string;
}

/** POST /api/workers/me/account-link/confirm | finalize */
export type AccountLinkConfirmResponse =
  | { status: 'merged'; recovered: Record<string, number>; workerStatus: string | null }
  | { status: 'conflicts'; conflicts: AccountLinkConflict[]; linkToken: string; accounts: { current: string; other: string } }
  | { status: 'REQUIRES_REVIEW' };

class WorkerApiServiceClass {
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json: ApiResponse<T> = await response.json();

    if (!json.success) {
      throw new ApiError(json as ApiErrorResponse, response.status);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  /**
   * GET /api/workers/lookup?email=...
   * Public endpoint (no auth). Checks if a worker exists by email.
   * Returns { found, phoneMasked? } — never leaks sensitive data.
   * On network error returns { found: false } so registration is never blocked.
   */
  async lookupByEmail(email: string): Promise<WorkerLookupResponse> {
    try {
      const params = new URLSearchParams({ email: email.trim().toLowerCase() });
      const response = await fetch(`${this.baseURL}/api/workers/lookup?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return { found: false };
      return await response.json();
    } catch {
      return { found: false };
    }
  }

  /**
   * POST /api/workers/init
   * Initialises the worker record on first registration.
   * Idempotent — if worker already exists, returns existing record.
   * Onda 2: may return { status: 'claim_pending', ... } when a phone match is detected.
   */
  async initWorker(payload: InitWorkerPayload): Promise<InitWorkerResponse> {
    return this.request<InitWorkerResponse>('POST', '/api/workers/init', payload);
  }

  /**
   * GET /api/workers/me
   * Returns the current authenticated worker's progress and data.
   * Throws if worker not found (404 from server becomes Error).
   */
  async getProgress(): Promise<WorkerProgressResponse> {
    return this.request<WorkerProgressResponse>('GET', '/api/workers/me');
  }

  /**
   * PUT /api/workers/step
   * Saves the data for a specific registration step and advances currentStep.
   */
  async saveStep(payload: SaveStepPayload): Promise<void> {
    await this.request<unknown>('PUT', '/api/workers/step', payload);
  }

  /**
   * PUT /api/workers/me/general-info
   * Saves general/personal info for the authenticated worker.
   */
  async saveGeneralInfo(data: Record<string, any>): Promise<void> {
    await this.request<unknown>('PUT', '/api/workers/me/general-info', data);
  }

  /**
   * POST /api/workers/me/account-link/lookup — SEM SMS, só mascarados. Abre a
   * modal no 409. Com ACCOUNT_LINK_ENABLED=false o endpoint não existe (404) —
   * o caller trata como fallback pro comportamento atual (toast).
   */
  async lookupAccountLink(phone: string): Promise<AccountLinkLookupResponse> {
    return this.request<AccountLinkLookupResponse>('POST', '/api/workers/me/account-link/lookup', { phone });
  }

  /**
   * POST /api/workers/me/account-link/start — dispara o OTP pro número DA
   * CONTA ANTIGA (anti-hijack), SÓ no clique em "vincular". Reenvio = chamar
   * de novo (rate-limit 3/h por conta).
   */
  async startAccountLink(phone: string): Promise<AccountLinkStartResponse> {
    return this.request<AccountLinkStartResponse>('POST', '/api/workers/me/account-link/start', { phone });
  }

  /**
   * POST /api/workers/me/account-link/confirm — valida o OTP. Sem conflito →
   * merge direto; com conflito → valores + linkToken pro finalize.
   */
  async confirmAccountLink(payload: {
    phone: string;
    verificationSid: string;
    otp: string;
  }): Promise<AccountLinkConfirmResponse> {
    return this.request<AccountLinkConfirmResponse>('POST', '/api/workers/me/account-link/confirm', payload);
  }

  /**
   * POST /api/workers/me/account-link/finalize — executa o merge com as
   * escolhas de campo (linkToken emitido no confirm).
   */
  async finalizeAccountLink(payload: {
    linkToken: string;
    fieldChoices?: Record<string, string>;
  }): Promise<AccountLinkConfirmResponse> {
    return this.request<AccountLinkConfirmResponse>('POST', '/api/workers/me/account-link/finalize', payload);
  }

  /**
   * PUT /api/workers/me/service-area
   * Saves the service area for the authenticated worker.
   */
  async saveServiceArea(data: Record<string, any>): Promise<void> {
    await this.request<unknown>('PUT', '/api/workers/me/service-area', data);
  }

  /**
   * GET /api/workers/me/availability
   * Returns the saved availability slots for the authenticated worker.
   */
  async getAvailability(): Promise<AvailabilitySlotResponse[]> {
    return this.request<AvailabilitySlotResponse[]>('GET', '/api/workers/me/availability');
  }

  /**
   * PUT /api/workers/me/availability
   * Saves the availability schedule for the authenticated worker.
   */
  async saveAvailability(data: { availability: Record<string, any>[] }): Promise<void> {
    await this.request<unknown>('PUT', '/api/workers/me/availability', data);
  }

  /**
   * POST /api/worker-applications/track-channel
   * Registers the acquisition channel (social origin) for a job application attempt.
   * Always called when jobPostingId is present — backend decides eligibility and
   * records blocked attempts (worker_blocked_applications). First-touch: backend
   * will not overwrite an existing channel. `channel` is nullable (direct links
   * have no UTM).
   */
  async trackAcquisitionChannel(jobPostingId: string, channel: string | null): Promise<void> {
    await this.request<unknown>('POST', '/api/worker-applications/track-channel', {
      jobPostingId,
      channel,
    });
  }
}

// Singleton instance
export const WorkerApiService = new WorkerApiServiceClass();
