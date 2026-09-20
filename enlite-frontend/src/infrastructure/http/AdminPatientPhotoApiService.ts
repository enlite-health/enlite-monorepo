/**
 * AdminPatientPhotoApiService
 *
 * Foto de perfil do paciente (spec 018, PR-4; `contracts/patient-header-and-photo.md`). Extraído
 * de `AdminApiService` para manter o teto de 400 linhas. Callers usam `AdminApiService` — ele
 * delega aqui transparentemente.
 *
 * Documentos y consentimiento de imagen (que vivia neste mesmo arquivo) foi REMOVIDO
 * (fix/018-remover-documentos-consentimento) — só a foto fica.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export interface PatientPhotoUploadResult {
  hasPhoto: true;
}

export interface SignedUrlResult {
  url: string;
  expiresInSeconds: number;
}

export class AdminPatientPhotoApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // DELETE .../photo devolve 204 sem corpo (contrato, linha 54) — `response.json()` num corpo
    // vazio lança `SyntaxError` antes de qualquer checagem de `success`. Sem isto, remover a foto
    // SEMPRE aparecia como falha na tela mesmo quando o backend apagou certinho (achado real,
    // medido no e2e de integração desta rodada).
    if (response.status === 204) return undefined as T;
    const json: ApiResponse<T> = await response.json();
    if (!json.success) throw new ApiError(json as ApiErrorResponse, response.status);
    return (json as ApiSuccessResponse<T>).data;
  }

  /** Multipart nunca leva `Content-Type` manual — o browser fecha o boundary. */
  private async requestMultipart<T>(method: string, path: string, form: FormData): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, { method, headers, body: form });
    const json: ApiResponse<T> = await response.json();
    if (!json.success) throw new ApiError(json as ApiErrorResponse, response.status);
    return (json as ApiSuccessResponse<T>).data;
  }

  // ========== Foto ==========

  async uploadPatientPhoto(patientId: string, file: File): Promise<PatientPhotoUploadResult> {
    const form = new FormData();
    form.append('file', file);
    return this.requestMultipart<PatientPhotoUploadResult>('POST', `/api/admin/patients/${patientId}/photo`, form);
  }

  async deletePatientPhoto(patientId: string): Promise<void> {
    await this.requestJson<unknown>('DELETE', `/api/admin/patients/${patientId}/photo`);
  }

  async getPatientPhotoUrl(patientId: string): Promise<SignedUrlResult> {
    return this.requestJson<SignedUrlResult>('GET', `/api/admin/patients/${patientId}/photo`);
  }
}

export const AdminPatientPhotoApiService = new AdminPatientPhotoApiServiceClass();
