/**
 * Implementação HTTP real da `AnaCareHoursService` — bate no contrato fixo da fase 1 (backend
 * implementado em paralelo por outro agente, MESMO contrato). Segue a convenção HTTP já usada no
 * painel (`AdminPatientsApiService.ts`): `FirebaseAuthService` para o token, envelope
 * `{success, data}` / `{success:false, error}`, base URL de `VITE_API_WORKER_FUNCTIONS_URL`.
 *
 * Contrato (fixo, não inventado aqui):
 *  - `GET  /api/admin/anacare-hours/months/:month`                      → `AnaCareMonthSnapshot`
 *  - `GET  /api/admin/anacare-hours/months/:month/patients/:patientId`  → `AnaCarePatient` | 404
 *  - `POST /api/admin/anacare-hours/shifts/:shiftId/validate`      body `{}`                → 204 | 409 `{code}`
 *  - `POST /api/admin/anacare-hours/shifts/validate-batch`         body `{shiftIds}`         → 204 | 409 `{code}`
 *  - `POST /api/admin/anacare-hours/shifts/:shiftId/contest`       body `{reason, note?}`     → 204 | 400/409 `{code}`
 *  - Qualquer GET pode devolver 503 `{code:'ANACARE_SOURCE_NOT_CONFIGURED'}` — vira
 *    `AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', ...)`, nunca tela branca (contrato do brief).
 *
 * DIVERGÊNCIA do contrato: não existe endpoint isolado para `getRetratoStatus` (só o snapshot do
 * mês inteiro trata `updatedAt/stale/circuitBreakerOpen`) — em vez de inventar uma rota nova,
 * `getRetratoStatus` busca o snapshot completo (sem filtro) e extrai os 3 campos. Custa mais
 * banda que um endpoint dedicado; documentado aqui e no bloco final da tarefa.
 *
 * Filtro por nome roda NO CLIENTE (`filterPatients`, `selectors.ts`) — nunca mandado como query
 * string ao backend (PII em URL/log é proibido pelo brief).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { assertValidContestCommand, AnaCareHoursServiceError, type AnaCareHoursMonthFilters, type AnaCareHoursService } from './AnaCareHoursService';
import { filterPatients } from './selectors';
import type {
  AnaCareMonthSnapshot,
  AnaCarePatient,
  AnaCareRetratoStatus,
  ContestShiftCommand,
  ValidateBatchCommand,
  ValidateShiftCommand,
} from './types';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
}

const KNOWN_ERROR_CODES: ReadonlySet<AnaCareHoursServiceError['code']> = new Set([
  'RETRATO_DESATUALIZADO',
  'JA_VALIDADO',
  'MOTIVO_INVALIDO',
  'NOTA_MUITO_LONGA',
  'FONTE_NAO_CONFIGURADA',
]);

function mapErrorCode(code: string | undefined, fallbackMessage: string): AnaCareHoursServiceError {
  const mapped = code && KNOWN_ERROR_CODES.has(code as AnaCareHoursServiceError['code']) ? (code as AnaCareHoursServiceError['code']) : undefined;
  return new AnaCareHoursServiceError(mapped ?? 'RETRATO_DESATUALIZADO', fallbackMessage);
}

export class AnaCareHoursHttpService implements AnaCareHoursService {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;
  private readonly basePath = '/api/admin/anacare-hours';

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

  /** GET — devolve `data` em sucesso, `null` em 404, lança `AnaCareHoursServiceError` (inclusive 503) em qualquer outro erro. */
  private async getJson<T>(path: string): Promise<T | null> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, { method: 'GET', headers });
    if (response.status === 404) return null;
    if (response.status === 503) {
      const body = await this.safeJson<ApiErrorResponse>(response);
      throw new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', body?.error ?? 'ANACARE_SOURCE_NOT_CONFIGURED');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new AnaCareHoursServiceError('RETRATO_DESATUALIZADO', `Erro ao conectar ao servidor (HTTP ${response.status}).`);
    }
    const json = (await response.json()) as ApiSuccessResponse<T> | ApiErrorResponse;
    if (!('success' in json) || !json.success) {
      const err = json as ApiErrorResponse;
      throw mapErrorCode(err.code, err.error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  /** POST — `void` em 204, lança `AnaCareHoursServiceError` mapeado pelo `code` do corpo em qualquer outro status. */
  private async postJson(path: string, body: unknown): Promise<void> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (response.status === 204) return;
    if (response.status === 503) {
      const errBody = await this.safeJson<ApiErrorResponse>(response);
      throw new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', errBody?.error ?? 'ANACARE_SOURCE_NOT_CONFIGURED');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new AnaCareHoursServiceError('RETRATO_DESATUALIZADO', `Erro ao conectar ao servidor (HTTP ${response.status}).`);
    }
    const errBody = (await response.json()) as ApiErrorResponse;
    throw mapErrorCode(errBody.code, errBody.error || `HTTP ${response.status}`);
  }

  private async safeJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async getMonthSnapshot(month: string, filters?: AnaCareHoursMonthFilters): Promise<AnaCareMonthSnapshot> {
    const snapshot = await this.getJson<AnaCareMonthSnapshot>(`${this.basePath}/months/${encodeURIComponent(month)}`);
    if (!snapshot) {
      return { month, updatedAt: new Date().toISOString(), stale: false, circuitBreakerOpen: false, patients: [] };
    }
    return { ...snapshot, patients: filterPatients(snapshot.patients, filters) };
  }

  async getPatientMonth(month: string, patientId: string): Promise<AnaCarePatient | null> {
    return this.getJson<AnaCarePatient>(`${this.basePath}/months/${encodeURIComponent(month)}/patients/${encodeURIComponent(patientId)}`);
  }

  async getRetratoStatus(month: string): Promise<AnaCareRetratoStatus> {
    const snapshot = await this.getJson<AnaCareMonthSnapshot>(`${this.basePath}/months/${encodeURIComponent(month)}`);
    if (!snapshot) return { updatedAt: new Date().toISOString(), stale: false, circuitBreakerOpen: false };
    return { updatedAt: snapshot.updatedAt, stale: snapshot.stale, circuitBreakerOpen: snapshot.circuitBreakerOpen };
  }

  async validateShift({ shiftId }: ValidateShiftCommand): Promise<void> {
    return this.postJson(`${this.basePath}/shifts/${encodeURIComponent(shiftId)}/validate`, {});
  }

  async validateBatch({ shiftIds }: ValidateBatchCommand): Promise<void> {
    return this.postJson(`${this.basePath}/shifts/validate-batch`, { shiftIds });
  }

  async contestShift({ shiftId, reason, note }: ContestShiftCommand): Promise<void> {
    // Defesa em profundidade (1.5b): a MESMA checagem que o backend aplica roda antes de sair da
    // máquina do usuário — nunca substitui a validação do servidor, só evita uma volta de rede
    // óbvia quando o `ContestModal` (por algum bug de UI) deixasse passar um valor inválido.
    assertValidContestCommand({ reason, note });
    return this.postJson(`${this.basePath}/shifts/${encodeURIComponent(shiftId)}/contest`, { reason, note });
  }
}
