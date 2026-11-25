export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  reason?: string;
  workerStatus?: string | null;
  missingFields?: string[];
  /** Link que o SERVIDOR monta para o time (ex.: CLAIM_CONFLICT do celular). O cliente nunca monta URL. */
  handoffUrl?: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export class ApiError extends Error {
  readonly code?: string;
  readonly reason?: string;
  readonly workerStatus?: string | null;
  readonly missingFields?: string[];
  readonly handoffUrl?: string;
  readonly status: number;

  constructor(payload: ApiErrorResponse, status: number) {
    super(payload.error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = payload.code;
    this.reason = payload.reason;
    this.workerStatus = payload.workerStatus;
    this.missingFields = payload.missingFields;
    this.handoffUrl = payload.handoffUrl;
    this.status = status;
  }
}
