/**
 * Implementação HTTP real de `AnaCareHoursExportService` (spec 032). Molde de download:
 * `WorkersExportApiService` — mas o nome do arquivo vem de `X-Export-Filename` (o ÚNICO header
 * exposto pelo CORS; `Content-Disposition` não chega ao navegador entre origens). Nenhum
 * `console.*`: o nome do arquivo e o id do paciente nunca vão para log.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AnaCareHoursServiceError } from './AnaCareHoursService';
import type { AnaCareHoursExportService, ExportPatientRangeCommand } from './AnaCareHoursExportService';

interface ApiErrorBody {
  error?: string;
  code?: string;
}

/** Erro do servidor → código do front. Só o que o backend manda; o resto é genérico (nunca arquivo vazio). */
function mapExportError(status: number, body: ApiErrorBody | null): AnaCareHoursServiceError {
  const message = body?.error ?? `HTTP ${status}`;
  if (status === 503 && body?.code === 'FONTE_SEM_INTERVALO') return new AnaCareHoursServiceError('FONTE_SEM_INTERVALO', message);
  if (status === 503) return new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', message);
  if (status === 403) return new AnaCareHoursServiceError('SEM_PERMISSAO', message);
  if (status === 400) return new AnaCareHoursServiceError('PEDIDO_INVALIDO', message);
  return new AnaCareHoursServiceError('DESCONHECIDO', message);
}

export class AnaCareHoursExportHttpService implements AnaCareHoursExportService {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;
  private readonly basePath = '/api/admin/anacare-hours';

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  async exportPatientRange({ patientId, desde, hasta }: ExportPatientRangeCommand): Promise<void> {
    const token = await this.authService.getIdToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const query = new URLSearchParams({ desde, hasta });
    const response = await fetch(`${this.baseURL}${this.basePath}/patients/${encodeURIComponent(patientId)}/export?${query}`, { method: 'GET', headers });

    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        try {
          body = (await response.json()) as ApiErrorBody;
        } catch {
          body = null;
        }
      }
      throw mapExportError(response.status, body);
    }

    const blob = await response.blob();
    const filename = response.headers.get('x-export-filename') || `horas-anacare-${desde}-${hasta}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  }
}
