import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from '@infrastructure/http/ApiError';
import { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

// ── Request / Response types ────────────────────────────────────────────────

export interface StartClaimInput {
  authUid: string;
  email: string;
  phone: string;
}

export type StartClaimResponse =
  | { noCandidate: true }
  | { phoneMasked: string; verificationSid: string };

export interface ConfirmClaimInput {
  verificationSid: string;
  otp: string;
  authUid: string;
  email: string;
  /** A caixa do aceite foi marcada (cadastro web). O OTP prova o telefone, não o aceite: sem isto o servidor não grava consentimento. */
  lgpdOptIn?: boolean;
}

export type ClaimErrorCode =
  | 'INVALID_OTP'
  | 'EXPIRED_OTP'
  | 'CANDIDATE_NOT_FOUND'
  | 'NOT_IMPORTABLE';

const CLAIM_ERROR_CODES: readonly ClaimErrorCode[] = ['INVALID_OTP', 'EXPIRED_OTP', 'CANDIDATE_NOT_FOUND', 'NOT_IMPORTABLE'];

export interface ConfirmClaimError {
  success: false;
  error: ClaimErrorCode;
}

export type ConfirmClaimResponse =
  | { success: true; worker: WorkerProgressResponse }
  | ConfirmClaimError;

// ── Internal API wrapper types ──────────────────────────────────────────────

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// ── Service ────────────────────────────────────────────────────────────────

class AuthClaimApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
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
      throw new ApiError(json as ApiErrorResponse & { reason?: string; workerStatus?: string | null }, response.status);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  /**
   * POST /api/auth/claim/start
   * Called after Google login to associate a WhatsApp phone with the account.
   * Returns { noCandidate: true } when no pre-existing ficha matches the phone.
   * Returns { phoneMasked, verificationSid } when a match is found
   * — the frontend must then prompt the user to confirm via OTP (ClaimOtpModal).
   */
  async startClaim(input: StartClaimInput): Promise<StartClaimResponse> {
    return this.request<StartClaimResponse>('POST', '/api/auth/claim/start', input);
  }

  /**
   * POST /api/auth/claim/confirm
   * Verifies the OTP and, if valid, merges the candidate worker record
   * into the newly created Firebase account.
   * On error, returns { success: false, error: ClaimErrorCode }.
   */
  async confirmClaim(input: ConfirmClaimInput): Promise<ConfirmClaimResponse> {
    // `request` devolve o `data` ({ worker }) e LANÇA no erro — o contrato aqui é o union que o
    // `useClaimConfirm` lê. Antes o `data` era devolvido cru: sem `success`, o hook tratava o
    // sucesso como falha e o modal nunca saía, mesmo com a ficha já transferida no banco.
    try {
      const { worker } = await this.request<{ worker: WorkerProgressResponse }>('POST', '/api/auth/claim/confirm', input);
      return { success: true, worker };
    } catch (err) {
      if (err instanceof ApiError && CLAIM_ERROR_CODES.includes(err.message as ClaimErrorCode)) {
        return { success: false, error: err.message as ClaimErrorCode };
      }
      throw err;
    }
  }
}

// Singleton instance
export const AuthClaimApiService = new AuthClaimApiServiceClass();
