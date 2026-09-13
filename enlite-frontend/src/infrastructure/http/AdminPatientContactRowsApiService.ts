/**
 * AdminPatientContactRowsApiService — escrita POR LINHA dos responsáveis e dos contatos de
 * emergência da cobertura (spec 018, PR-1, ADR-1; contracts/support-network.md).
 *
 * Substitui `PATCH /patients/:id/support-network` (410, SUP-37) e o campo `emergencyContacts` de
 * `PATCH /patients/:id/coverage` (saiu do payload, 400 se mandado) — ver `PatientCoverage.ts` e
 * `PatientSectionPayloads.ts`. Extraído para arquivo próprio (teto de 400 linhas do
 * `AdminApiService`); callers usam `AdminApiService`, que delega transparentemente.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  PatientResponsibleInput,
  PatientResponsiblePatch,
  PatientProfessionalInput,
  PatientProfessionalPatch,
  PatientExternalContactInput,
  PatientExternalContactPatch,
} from '@domain/entities/PatientSectionPayloads';
import type { PatientCoverageEmergencyContactInput, PatientCoverageEmergencyContactPatch } from '@domain/entities/PatientCoverage';
import type { EmergencyContactRef } from '@domain/entities/PatientDetail';
import { PatientApiError } from './AdminPatientsApiService';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminPatientContactRowsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as unknown as { env: Record<string, string> }).env
      ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async writeJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new PatientApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      const err = json as ApiErrorResponse;
      throw new PatientApiError(err.error || `HTTP ${response.status}`, response.status, err);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  // ── Responsáveis ──────────────────────────────────────────────────────────────────────────

  /** POST /api/admin/patients/:id/responsibles */
  async createResponsible(patientId: string, input: PatientResponsibleInput): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('POST', `/api/admin/patients/${patientId}/responsibles`, input);
  }

  /** PATCH /api/admin/patients/:id/responsibles/:rid */
  async updateResponsible(patientId: string, id: string, patch: PatientResponsiblePatch): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('PATCH', `/api/admin/patients/${patientId}/responsibles/${id}`, patch);
  }

  /** POST /api/admin/patients/:id/responsibles/:rid/deactivate */
  async deactivateResponsible(patientId: string, id: string): Promise<{ id: string; active: false; emergencyMarkCleared: boolean }> {
    return this.writeJson<{ id: string; active: false; emergencyMarkCleared: boolean }>('POST', `/api/admin/patients/${patientId}/responsibles/${id}/deactivate`);
  }

  // ── Contatos externos sem vínculo familiar (spec 018, PR-2, `lex` #4) ────────────────────────

  /** POST /api/admin/patients/:id/external-contacts */
  async createExternalContact(patientId: string, input: PatientExternalContactInput): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('POST', `/api/admin/patients/${patientId}/external-contacts`, input);
  }

  /** PATCH /api/admin/patients/:id/external-contacts/:xid */
  async updateExternalContact(patientId: string, id: string, patch: PatientExternalContactPatch): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('PATCH', `/api/admin/patients/${patientId}/external-contacts/${id}`, patch);
  }

  /** POST /api/admin/patients/:id/external-contacts/:xid/deactivate */
  async deactivateExternalContact(patientId: string, id: string): Promise<{ id: string; active: false; emergencyMarkCleared: boolean }> {
    return this.writeJson<{ id: string; active: false; emergencyMarkCleared: boolean }>('POST', `/api/admin/patients/${patientId}/external-contacts/${id}/deactivate`);
  }

  // ── Marca de emergência (spec 018, PR-2, D-A) ───────────────────────────────────────────────

  /** PUT /api/admin/patients/:id/emergency-contact */
  async markEmergencyContact(patientId: string, target: EmergencyContactRef): Promise<{ emergencyContactRef: EmergencyContactRef }> {
    return this.writeJson<{ emergencyContactRef: EmergencyContactRef }>('PUT', `/api/admin/patients/${patientId}/emergency-contact`, target);
  }

  /** DELETE /api/admin/patients/:id/emergency-contact */
  async unmarkEmergencyContact(patientId: string): Promise<{ emergencyContactRef: null }> {
    return this.writeJson<{ emergencyContactRef: null }>('DELETE', `/api/admin/patients/${patientId}/emergency-contact`);
  }

  // ── Contatos de emergência da cobertura ──────────────────────────────────────────────────────

  /** POST /api/admin/patients/:id/coverage-emergency-contacts */
  async createCoverageEmergencyContact(patientId: string, input: PatientCoverageEmergencyContactInput): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('POST', `/api/admin/patients/${patientId}/coverage-emergency-contacts`, input);
  }

  /** PATCH /api/admin/patients/:id/coverage-emergency-contacts/:cid */
  async updateCoverageEmergencyContact(patientId: string, id: string, patch: PatientCoverageEmergencyContactPatch): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('PATCH', `/api/admin/patients/${patientId}/coverage-emergency-contacts/${id}`, patch);
  }

  /** POST /api/admin/patients/:id/coverage-emergency-contacts/:cid/deactivate */
  async deactivateCoverageEmergencyContact(patientId: string, id: string): Promise<{ id: string; active: false }> {
    return this.writeJson<{ id: string; active: false }>('POST', `/api/admin/patients/${patientId}/coverage-emergency-contacts/${id}/deactivate`);
  }

  // ── Equipe tratante (`patient_professionals`, spec 018 PR-5, US-11) ─────────────────────────

  /** POST /api/admin/patients/:id/professionals */
  async createProfessional(patientId: string, input: PatientProfessionalInput): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('POST', `/api/admin/patients/${patientId}/professionals`, input);
  }

  /** PATCH /api/admin/patients/:id/professionals/:pid */
  async updateProfessional(patientId: string, id: string, patch: PatientProfessionalPatch): Promise<{ id: string }> {
    return this.writeJson<{ id: string }>('PATCH', `/api/admin/patients/${patientId}/professionals/${id}`, patch);
  }

  /** POST /api/admin/patients/:id/professionals/:pid/deactivate */
  async deactivateProfessional(patientId: string, id: string): Promise<{ id: string; active: false }> {
    return this.writeJson<{ id: string; active: false }>('POST', `/api/admin/patients/${patientId}/professionals/${id}/deactivate`);
  }
}

export const AdminPatientContactRowsApiService = new AdminPatientContactRowsApiServiceClass();
