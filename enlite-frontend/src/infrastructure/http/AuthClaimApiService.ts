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
  | { candidateWorkerId: string; phoneMasked: string; verificationSid: string };

export interface ConfirmClaimInput {
  verificationSid: string;
  otp: string;
  authUid: string;
  email: string;
  candidateWorkerId: string;
}

export type ClaimErrorCode =
  | 'INVALID_OTP'
  | 'EXPIRED_OTP'
  | 'CANDIDATE_NOT_FOUND'
  | 'NOT_IMPORTABLE';

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
   * Returns { candidateWorkerId, phoneMasked, verificationSid } when a match is found
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
    return this.request<ConfirmClaimResponse>(
      'POST',
      '/api/auth/claim/confirm',
      input,
    );
  }
}

// Singleton instance
export const AuthClaimApiService = new AuthClaimApiServiceClass();
