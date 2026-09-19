/**
 * Implementação HTTP real de `AxonicoComprobanteService` — MESMA convenção de
 * `AnaCareHoursHttpService.ts` (token via `FirebaseAuthService`, envelope `{success, data}` /
 * `{success:false, error, message}`, base URL de `VITE_API_WORKER_FUNCTIONS_URL`), mas rota
 * BASE diferente: `/api/admin/integrations/axonico` (não `/api/admin/anacare-hours` — são domínios
 * distintos, a integração Axonico não é parte do domínio "horas do Ana Care").
 *
 * ⚠️ `documentNumber` é PII (regra dura do brief) — nunca em query string/URL, sempre no corpo do
 * POST; e este arquivo nunca loga request nem response (nenhum `console.*`).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AxonicoComprobanteServiceError, type AxonicoComprobanteService, type EnviarComprobanteAxonicoCommand, type EnviarComprobanteAxonicoResult } from './AxonicoComprobanteService';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  message: string;
}

export class AxonicoComprobanteHttpService implements AxonicoComprobanteService {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;
  private readonly basePath = '/api/admin/integrations/axonico';

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

  async enviarComprobante(command: EnviarComprobanteAxonicoCommand): Promise<EnviarComprobanteAxonicoResult> {
    const headers = await this.getAuthHeaders();
    const body = {
      documentNumber: command.documentNumber,
      ...(command.documentType ? { documentType: command.documentType } : {}),
      serviceType: 'AT' as const,
      serviceDate: command.serviceDate,
      hours: command.hours,
    };
    const response = await fetch(`${this.baseURL}${this.basePath}/comprobante`, { method: 'POST', headers, body: JSON.stringify(body) });

    // Nunca confia em `response.ok` sozinho (o contrato manda `success:false` no CORPO em
    // 400/404/409/422/502, e um envelope malformado num 200 também tem de virar erro legível) —
    // o `content-type` só descarta o caso em que o servidor nem devolveu JSON (ex. 502 de proxy).
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new AxonicoComprobanteServiceError('DESCONHECIDO', `Error al conectar con el servidor (HTTP ${response.status}).`);
    }

    const json = (await response.json()) as ApiSuccessResponse<EnviarComprobanteAxonicoResult> | ApiErrorResponse;
    if (!('success' in json) || !json.success) {
      const err = json as ApiErrorResponse;
      throw new AxonicoComprobanteServiceError(err.error ?? 'DESCONHECIDO', err.message || `HTTP ${response.status}`);
    }
    return json.data;
  }
}
