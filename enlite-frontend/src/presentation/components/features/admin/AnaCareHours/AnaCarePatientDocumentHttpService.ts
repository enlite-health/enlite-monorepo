/**
 * Implementação HTTP real de `AnaCarePatientDocumentService` — MESMA convenção de
 * `AxonicoComprobanteHttpService.ts` (token via `FirebaseAuthService`, envelope `{success, data}` /
 * `{success:false, error, message}`, base URL de `VITE_API_WORKER_FUNCTIONS_URL`), rota BASE
 * `/api/admin/integrations/anacare` (domínio "integração com o Ana Care", diferente do domínio
 * Axonico e do domínio `anacare-hours`).
 *
 * ⚠️ `documentNumber` é PII (mesma regra dura do brief do Axonico) — nunca em query string/URL,
 * sempre no corpo do POST; e este arquivo nunca loga request nem response (nenhum `console.*`).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import {
  AnaCarePatientDocumentServiceError,
  type AnaCarePatientDocumentService,
  type RegisterAnaCarePatientDocumentCommand,
  type RegisterAnaCarePatientDocumentResult,
} from './AnaCarePatientDocumentService';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  message: string;
}

export class AnaCarePatientDocumentHttpService implements AnaCarePatientDocumentService {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;
  private readonly basePath = '/api/admin/integrations/anacare';

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async registerDocument(command: RegisterAnaCarePatientDocumentCommand): Promise<RegisterAnaCarePatientDocumentResult> {
    const headers = await this.getAuthHeaders();
    const body = {
      anaCarePatientId: command.anaCarePatientId,
      documentNumber: command.documentNumber,
      ...(command.documentType ? { documentType: command.documentType } : {}),
    };
    const response = await fetch(`${this.baseURL}${this.basePath}/patient-document`, { method: 'POST', headers, body: JSON.stringify(body) });

    // Mesma cautela de `AxonicoComprobanteHttpService`: nunca confia em `response.ok` sozinho — o
    // contrato manda `success:false` no CORPO em 400/409/422, e `content-type` só descarta o caso
    // em que o servidor nem devolveu JSON (ex. 502 de proxy).
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new AnaCarePatientDocumentServiceError('DESCONHECIDO', `Error al conectar con el servidor (HTTP ${response.status}).`);
    }

    const json = (await response.json()) as ApiSuccessResponse<RegisterAnaCarePatientDocumentResult> | ApiErrorResponse;
    if (!('success' in json) || !json.success) {
      const err = json as ApiErrorResponse;
      throw new AnaCarePatientDocumentServiceError(err.error ?? 'DESCONHECIDO', err.message || `HTTP ${response.status}`);
    }
    return json.data;
  }
}
