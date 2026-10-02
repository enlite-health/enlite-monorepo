/**
 * AdminPatientDocumentsApiService
 *
 * Aba "Documentos" da ficha do paciente (spec 031, D463). O contrato é o de
 * `worker-functions/src/modules/patient-documents/interfaces/routes/patientDocumentsRoutes.ts`
 * (5 rotas sob `/api/admin/patients/:id/documents`). Molde: `AdminConversationApiService.ts` —
 * mesmo `getAuthHeaders`/`requestJson`/`requestMultipart`.
 *
 * `DELETE` responde 204 SEM corpo (`PatientDocumentsController.remove`) — por isso `requestJson`
 * aqui não chama `response.json()` nesse caso, ao contrário do molde.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export type PatientDocumentOrigin = 'tab' | 'chat';

/** Forma da lista (`PatientDocumentDto` do backend). */
export interface PatientDocument {
  id: string;
  origin: PatientDocumentOrigin;
  /** `null` só quando a decifra falhou para ESTE item — a tela cai num rótulo genérico. */
  label: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  createdByUid: string;
  createdByDisplayName: string | null;
  labelUpdatedAt: string | null;
}

/** `GET .../documents/:docId/url` — URL assinada de 300 s, pedida a cada clique em "Ver". */
export interface PatientDocumentSignedUrl {
  url: string;
  expiresInSeconds: number;
}

export class AdminPatientDocumentsApiServiceClass {
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

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const json: ApiResponse<T> = await response.json();
    if (!json.success) throw new ApiError(json as ApiErrorResponse, response.status);
    return (json as ApiSuccessResponse<T>).data;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(response);
  }

  /** Multipart nunca leva `Content-Type` manual — o browser fecha o boundary. */
  private async requestMultipart<T>(method: string, path: string, form: FormData): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, { method, headers, body: form });
    return this.parse<T>(response);
  }

  async listPatientDocuments(patientId: string): Promise<PatientDocument[]> {
    return this.requestJson<PatientDocument[]>('GET', `/api/admin/patients/${patientId}/documents`);
  }

  /** Campos do multipart: `label` (nome livre) e `file`. */
  async uploadPatientDocument(patientId: string, label: string, file: File): Promise<PatientDocument> {
    const form = new FormData();
    form.append('label', label);
    form.append('file', file);
    return this.requestMultipart<PatientDocument>('POST', `/api/admin/patients/${patientId}/documents`, form);
  }

  async renamePatientDocument(patientId: string, docId: string, label: string): Promise<PatientDocument> {
    return this.requestJson<PatientDocument>('PATCH', `/api/admin/patients/${patientId}/documents/${docId}`, { label });
  }

  async deletePatientDocument(patientId: string, docId: string): Promise<void> {
    await this.requestJson<void>('DELETE', `/api/admin/patients/${patientId}/documents/${docId}`);
  }

  async getPatientDocumentUrl(patientId: string, docId: string): Promise<PatientDocumentSignedUrl> {
    return this.requestJson<PatientDocumentSignedUrl>('GET', `/api/admin/patients/${patientId}/documents/${docId}/url`);
  }
}

export const AdminPatientDocumentsApiService = new AdminPatientDocumentsApiServiceClass();
