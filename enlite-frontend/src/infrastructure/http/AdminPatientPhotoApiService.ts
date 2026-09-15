/**
 * AdminPatientPhotoApiService
 *
 * Foto de perfil, documento (prova do consentimento) e consentimento de imagem do paciente
 * (spec 018, PR-4; `contracts/patient-header-and-photo.md`). Extraído de `AdminApiService` para
 * manter o teto de 400 linhas. Callers usam `AdminApiService` — ele delega aqui transparentemente.
 *
 * D335 (14/09/2026): as travas legais (consentimento obrigatório antes do upload, representante
 * obrigatório para menor, documento obrigatório no consentimento) foram REMOVIDAS pelo Gabriel —
 * o backend NÃO retorna 409 IMAGE_CONSENT_REQUIRED nem 422 REPRESENTATIVE_REQUIRED/
 * IMAGE_CONSENT_DOCUMENT_REQUIRED. Este client não trata esses códigos como caso especial: eles
 * seguem o fluxo genérico de erro (ApiError) como qualquer outro.
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

export interface PatientDocumentUploadResult {
  documentId: string;
}

export type PatientDocumentType = 'image_consent' | 'image_consent_revocation';

/** GET /patients/:id/documents — metadados, SEM url assinada (furo fechado nesta rodada). */
export interface PatientDocumentListItem {
  id: string;
  documentType: PatientDocumentType;
  contentType: 'application/pdf' | 'image/jpeg';
  sizeBytes: number;
  uploadedAt: string;
}

/** GET /patients/:id/image-consents/vigente — `null` quando não há consentimento vigente. */
export interface VigenteImageConsentResult {
  id: string;
  consenterKind: 'PATIENT' | 'REPRESENTATIVE';
  consentedAt: string;
}

export interface RegisterImageConsentPayload {
  consenterKind: 'PATIENT' | 'REPRESENTATIVE';
  responsibleId?: string;
  documentId?: string;
  textVersion: string;
  consentedAt: string;
  representationBasis?: string;
  representationVerifiedBy?: string;
}

export interface RegisterImageConsentResult {
  id: string;
}

export type RevocationChannel = 'WRITTEN' | 'EMAIL' | 'IN_PERSON' | 'PHONE';

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

  // ========== Documento (prova) ==========

  async uploadPatientDocument(
    patientId: string,
    file: File,
    documentType: PatientDocumentType,
  ): Promise<PatientDocumentUploadResult> {
    const form = new FormData();
    form.append('file', file);
    form.append('documentType', documentType);
    return this.requestMultipart<PatientDocumentUploadResult>('POST', `/api/admin/patients/${patientId}/documents`, form);
  }

  async getPatientDocumentUrl(patientId: string, documentId: string): Promise<SignedUrlResult> {
    return this.requestJson<SignedUrlResult>('GET', `/api/admin/patients/${patientId}/documents/${documentId}`);
  }

  /** GET /patients/:id/documents — lista o que está persistido (recarregar a página não perde nada). */
  async listPatientDocuments(patientId: string): Promise<PatientDocumentListItem[]> {
    return this.requestJson<PatientDocumentListItem[]>('GET', `/api/admin/patients/${patientId}/documents`);
  }

  // ========== Consentimento de imagem (opcional — D335) ==========

  async registerImageConsent(
    patientId: string,
    payload: RegisterImageConsentPayload,
  ): Promise<RegisterImageConsentResult> {
    return this.requestJson<RegisterImageConsentResult>('POST', `/api/admin/patients/${patientId}/image-consents`, payload);
  }

  async revokeImageConsent(
    patientId: string,
    consentId: string,
    payload: { revocationDocumentId?: string; revocationChannel: RevocationChannel },
  ): Promise<void> {
    await this.requestJson<unknown>('POST', `/api/admin/patients/${patientId}/image-consents/${consentId}/revoke`, payload);
  }

  /** GET /patients/:id/image-consents/vigente — furo fechado nesta rodada (recarregar mostra o estado real). */
  async getVigenteImageConsent(patientId: string): Promise<VigenteImageConsentResult | null> {
    return this.requestJson<VigenteImageConsentResult | null>('GET', `/api/admin/patients/${patientId}/image-consents/vigente`);
  }
}

export const AdminPatientPhotoApiService = new AdminPatientPhotoApiServiceClass();
