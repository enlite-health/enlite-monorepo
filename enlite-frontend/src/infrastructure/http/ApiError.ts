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
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export class ApiError extends Error {
  readonly code?: string;
  readonly reason?: string;
  readonly workerStatus?: string | null;
  readonly status: number;

  constructor(payload: ApiErrorResponse, status: number) {
    super(payload.error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = payload.code;
    this.reason = payload.reason;
    this.workerStatus = payload.workerStatus;
    this.status = status;
  }
}
