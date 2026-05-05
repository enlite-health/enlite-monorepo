/**
 * AdminVacancyAddressApiService
 *
 * Handles the Phase 8 "pending address review" endpoints:
 *   - GET  /api/admin/vacancies/pending-address-review
 *   - POST /api/admin/vacancies/:id/resolve-address-review
 *   - GET  /api/admin/patients/:patientId/addresses
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  PendingAddressReviewItem,
  PatientAddressRow,
} from '@domain/entities/PatientAddress';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  total?: number;
}

interface ApiErrorResponse {
  success: false;
  error: string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export type ResolveAddressBody =
  | { patient_address_id: string }
  | { createAddress: { address_formatted: string; address_raw?: string; address_type: string } };

class AdminVacancyAddressApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiSuccessResponse<T>> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return json as ApiSuccessResponse<T>;
  }

  async listPendingAddressReview(
    statusFilter?: string,
  ): Promise<{ data: PendingAddressReviewItem[]; total: number }> {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    const result = await this.request<PendingAddressReviewItem[]>(
      'GET',
      `/api/admin/vacancies/pending-address-review${qs}`,
    );
    return { data: result.data, total: result.total ?? result.data.length };
  }

  async resolveAddressReview(vacancyId: string, body: ResolveAddressBody): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/api/admin/vacancies/${vacancyId}/resolve-address-review`,
      body,
    );
  }

  async listPatientAddresses(patientId: string): Promise<PatientAddressRow[]> {
    // Postgres `numeric` arrives as string over JSON; normalize lat/lng to
    // numbers so consumers (ServiceAreaMap, etc.) don't need to coerce.
    const result = await this.request<Array<Omit<PatientAddressRow, 'lat' | 'lng'> & {
      lat: number | string | null;
      lng: number | string | null;
    }>>(
      'GET',
      `/api/admin/patients/${patientId}/addresses`,
    );
    return result.data.map((r) => ({
      ...r,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
    }));
  }
}

export const AdminVacancyAddressApiService = new AdminVacancyAddressApiServiceClass();
