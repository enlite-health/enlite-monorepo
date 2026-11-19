/**
 * AdminDailyReportsApiService — leitura dos informes da guarda de UM paciente (spec 092, T501).
 *
 * `GET /api/admin/patients/:patientId/daily-reports` (`adminDailyReportRoutes.ts`) responde `{ items }` DIRETO (sem o envelope
 * `{ success, data }` das demais rotas admin) e o erro como `{ success: false, error }`. Por isso `fetch` próprio, e não
 * `AdminContractedServicesApiService.request`. O corpo de erro nunca traz informe; o status (403 sem `daily_report:read`) vira
 * `DailyReportsApiError.status` para a aba distinguir "sem acesso" de "falhou".
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { PatientDailyReportsResult } from '@domain/entities/PatientDailyReport';

export class DailyReportsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DailyReportsApiError';
    this.status = status;
  }
}

export class AdminDailyReportsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  async listForPatient(patientId: string): Promise<PatientDailyReportsResult> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/api/admin/patients/${patientId}/daily-reports`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = (await response.json().catch(() => null)) as { items?: unknown; error?: string } | null;
    if (!response.ok || !body || !Array.isArray(body.items)) {
      throw new DailyReportsApiError(body?.error ?? `HTTP ${response.status}`, response.status);
    }
    return body as PatientDailyReportsResult;
  }
}

export const AdminDailyReportsApiService = new AdminDailyReportsApiServiceClass();
