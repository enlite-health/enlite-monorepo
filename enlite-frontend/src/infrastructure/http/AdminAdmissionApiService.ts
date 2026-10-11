/**
 * AdminAdmissionApiService
 *
 * Aba "Admisión" da ficha do paciente e vínculo do Tactiq do operador (spec 049, F7). O contrato é o de
 * `worker-functions/src/modules/matching/interfaces/controllers/AdmissionPanelController.ts` e
 * `TactiqLinkController.ts`. Molde: `AdminPatientDocumentsApiService.ts`.
 *
 * Erros de domínio chegam com `code` estável (`ApiError.code`): SLOT_TAKEN, TACTIQ_LINK_REQUIRED (409),
 * RESEND_NOT_ALLOWED, RESEND_LIMIT_REACHED, RESEND_IN_PROGRESS, SUMMARY_RETRY_NOT_ALLOWED, SUMMARY_RETRY_LIMIT_REACHED (409), SLOT_IN_PAST e HOST_NOT_IN_ROSTER (422), CALENDAR_CREATE_FAILED (502).
 * Nada aqui loga corpo, e-mail nem telefone.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export type AdmissionCountry = 'AR' | 'BR';

/** Espelha `MessageSeal` do back (`domain/admissionSeals.ts`). */
export type MessageSeal =
  | 'none'
  | 'scheduled'
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'no_consent'
  | 'skipped'
  | 'cancelled';

export interface MessageSealView {
  seal: MessageSeal;
  attempt: number | null;
  /** O servidor decide (falhou, dentro do teto, reunião ativa, lembrete antes do início). A tela não recalcula. */
  canResend: boolean;
}

/** Coluna `import_status` da reunião (migration 503). `null` = reunião antiga / fora da importação. */
export type AdmissionImportStatus =
  | 'pending'
  | 'waiting'
  | 'done'
  | 'rejected'
  | 'ambiguous'
  | 'expired'
  | 'blocked'
  | 'no_show';

export type AdmissionAppointmentStatus = 'booked' | 'cancelled' | 'completed' | 'no_show';

/** Estado do botão "Reintentar resumen" (spec 050 F11, R-38): o servidor decide; `null`/ausente = sem botão. */
export interface SummaryRetryView {
  /** 3 chamadas pagas gastas desde a última autorização: o botão AUTORIZA uma rodada nova (com custo). Falso: só roda agora. */
  exhausted: boolean;
  /** Autorizações que ainda restam (teto 2). `exhausted && authorizationsLeft === 0` = sem saída pelo botão. */
  authorizationsLeft: number;
}

export interface AdmissionAppointment {
  id: string;
  admissionCode: string | null;
  createdVia: 'site' | 'panel';
  country: string;
  hostEmail: string;
  slotStart: string;
  slotEnd: string;
  status: AdmissionAppointmentStatus | string;
  /** Cancelada e o Google ainda não apagou o evento (spec 050 R-36); o job repete até apagar. */
  calendarEventPending: boolean;
  meetLink: string | null;
  seals: {
    confirmation: MessageSealView;
    reminder: MessageSealView;
    import: AdmissionImportStatus | null;
    document: { id: string } | null;
  };
  /** Spec 050 F11. Ausente em resposta antiga. */
  summaryRetry?: SummaryRetryView | null;
}

export type TactiqLinkState = 'missing' | 'linked' | 'broken' | 'wrong_account' | 'revoked';

export interface AdmissionHost {
  email: string;
  displayName: string | null;
  linked: boolean;
  linkState: TactiqLinkState;
}

export interface AdmissionBookResult {
  appointmentId?: string;
  admissionCode: string;
  [key: string]: unknown;
}

export interface AdmissionSummaryRetryResult {
  appointmentId: string;
  /** `authorized`: +1 rodada autorizada, a reunião voltou à fila. `run_now`: rodou agora, sem autorização nova. */
  mode: 'authorized' | 'run_now';
  authorizationsUsed: number;
  authorizationsLeft: number;
  /** Só em `run_now`: o resultado da importação disparada agora (`done`, `summary_failed`, ...). */
  outcome?: string;
}

export interface AdmissionResendResult {
  outcome: string;
  skip?: string;
}

/** `GET /api/admin/me/tactiq-link` — NUNCA carrega token. */
export interface OwnTactiqLink {
  status: TactiqLinkState;
  linkedAt: string | null;
  lastCheckAt: string | null;
  statusChangedAt: string | null;
}

export type ResendKind = 'confirmation' | 'reminder_30min';

export class AdminAdmissionApiServiceClass {
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
    const json: ApiResponse<T> = await response.json();
    if (!json.success) throw new ApiError(json as ApiErrorResponse, response.status);
    return (json as ApiSuccessResponse<T>).data;
  }

  async listAppointments(patientId: string): Promise<AdmissionAppointment[]> {
    return this.requestJson<AdmissionAppointment[]>('GET', `/api/admin/patients/${patientId}/admission-appointments`);
  }

  async listHosts(country: AdmissionCountry): Promise<AdmissionHost[]> {
    return this.requestJson<AdmissionHost[]>('GET', `/api/admin/admission/hosts?country=${country}`);
  }

  /** `slotStartISO` é a hora de PAREDE no fuso do país do paciente (sem offset): quem a interpreta é o servidor. */
  async bookAppointment(patientId: string, input: { hostEmail: string; slotStartISO: string }): Promise<AdmissionBookResult> {
    return this.requestJson<AdmissionBookResult>('POST', `/api/admin/patients/${patientId}/admission-appointments`, input);
  }

  async cancelAppointment(patientId: string, appointmentId: string): Promise<void> {
    await this.requestJson<unknown>('POST', `/api/admin/patients/${patientId}/admission-appointments/${appointmentId}/cancel`);
  }

  async resendMessage(patientId: string, appointmentId: string, kind: ResendKind): Promise<AdmissionResendResult> {
    return this.requestJson<AdmissionResendResult>(
      'POST',
      `/api/admin/patients/${patientId}/admission-appointments/${appointmentId}/messages/${kind}/resend`,
    );
  }

  async retrySummary(patientId: string, appointmentId: string): Promise<AdmissionSummaryRetryResult> {
    return this.requestJson<AdmissionSummaryRetryResult>(
      'POST',
      `/api/admin/patients/${patientId}/admission-appointments/${appointmentId}/summary-retry`,
    );
  }

  async getOwnTactiqLink(): Promise<OwnTactiqLink> {
    return this.requestJson<OwnTactiqLink>('GET', '/api/admin/me/tactiq-link');
  }

  /** Inicia o OAuth: a tela redireciona o navegador para `authorizeUrl`. */
  async startTactiqLink(): Promise<{ authorizeUrl: string }> {
    return this.requestJson<{ authorizeUrl: string }>('POST', '/api/admin/me/tactiq-link');
  }
}

export const AdminAdmissionApiService = new AdminAdmissionApiServiceClass();
