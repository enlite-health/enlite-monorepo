/**
 * AdminDiagnosisApiService — CRUD do diagnóstico estruturado do paciente (spec 016 F3).
 *   POST  /api/admin/patients/:id/diagnoses           { conceptUri, isPrimary? }
 *   PATCH /api/admin/patients/:id/diagnoses/:did       { isPrimary: true } | { active: false }
 * Sem DELETE — baixa é `active:false`, nunca remoção física (D263, mesmo contrato do backend).
 * `conceptUri` é OPACO: este client nunca lê nem envia code/title/chapter/release do lado do
 * cliente — quem resolve é o servidor (Contrato de arquitetura da spec 016).
 *
 * Extraído em arquivo próprio (molde `AdminContractedServicesApiService.ts`).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

export type DiagnosisApiErrorCode =
  | 'CONCEPT_NOT_RESOLVED'
  | 'CONCEPT_NOT_DIAGNOSABLE'
  | 'PRIMARY_DIAGNOSIS_RACE'
  | 'DIAGNOSIS_ALREADY_ACTIVE'
  | 'DIAGNOSIS_NOT_ACTIVE'
  | 'TERMINOLOGY_UNAVAILABLE';

/** Carrega status HTTP + `code` do backend — a tela traduz pelo `code`, nunca repete a frase em inglês do servidor. */
export class DiagnosisApiError extends Error {
  readonly status: number;
  readonly code?: DiagnosisApiErrorCode;

  constructor(message: string, status: number, code?: DiagnosisApiErrorCode) {
    super(message);
    this.name = 'DiagnosisApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
  code?: DiagnosisApiErrorCode;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminDiagnosisApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  // As 3 rotas desta classe (create/promote/deactivate) SEMPRE mandam corpo — nenhuma é GET.
  // `body` é obrigatório de propósito: um parâmetro opcional aqui criaria um ramo (`undefined`)
  // que nenhum chamador real exercita — código morto que passaria despercebido pela cobertura.
  private async request(method: string, path: string, body: unknown): Promise<PatientDiagnosisDetail> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new DiagnosisApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json = (await response.json()) as ApiResponse<PatientDiagnosisDetail>;
    if (!json.success) {
      throw new DiagnosisApiError(json.error || `HTTP ${response.status}`, response.status, json.code);
    }
    return json.data;
  }

  /** POST /api/admin/patients/:id/diagnoses */
  async create(patientId: string, conceptUri: string, isPrimary?: boolean): Promise<PatientDiagnosisDetail> {
    return this.request('POST', `/api/admin/patients/${patientId}/diagnoses`, {
      conceptUri,
      ...(isPrimary !== undefined ? { isPrimary } : {}),
    });
  }

  /** PATCH .../:did { isPrimary: true } — promove a principal; o servidor rebaixa a anterior. */
  async promote(patientId: string, diagnosisId: string): Promise<PatientDiagnosisDetail> {
    return this.request('PATCH', `/api/admin/patients/${patientId}/diagnoses/${diagnosisId}`, { isPrimary: true });
  }

  /** PATCH .../:did { active: false } — baixa; NUNCA DELETE físico. */
  async deactivate(patientId: string, diagnosisId: string): Promise<PatientDiagnosisDetail> {
    return this.request('PATCH', `/api/admin/patients/${patientId}/diagnoses/${diagnosisId}`, { active: false });
  }
}

export const AdminDiagnosisApiService = new AdminDiagnosisApiServiceClass();
