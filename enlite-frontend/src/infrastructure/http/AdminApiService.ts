import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AdminUser } from '@domain/entities/AdminUser';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { WorkerDateStats, WorkerDetail, WorkerDocument, DocumentValidations } from '@domain/entities/Worker';
import type {
  MatchResultsResponse,
  MessageTemplate,
  WhatsAppSentResult,
} from '../../types/match';
import type { InterviewSlot, CreateSlotsInput, BookSlotResult, InterviewSlotsSummary } from '@domain/entities/InterviewSlot';
import {
  AdminWorkerDocsApiService,
  type AdminAdditionalDocument,
} from './AdminWorkerDocsApiService';
import {
  AdminPatientsApiService,
} from './AdminPatientsApiService';
import {
  AdminVacancyParseApiService,
} from './AdminVacancyParseApiService';
import {
  AdminVacancyAddressApiService,
  type ResolveAddressBody,
} from './AdminVacancyAddressApiService';
import {
  AdminTalentumApiService,
  type AIContentResult,
} from './AdminTalentumApiService';
import type {
  ParseVacancyFullResult,
  PatientAddressCreateInput,
  PatientAddressRow,
  PendingAddressReviewItem,
} from '@domain/entities/PatientAddress';

export type { WorkerDateStats, AdminAdditionalDocument };
export type { ParseVacancyFullResult, PatientAddressCreateInput, PatientAddressRow };
export type { PendingAddressReviewItem, ResolveAddressBody };
export type { AIContentResult };

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL
      || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json: ApiResponse<T> = await response.json();

    if (!json.success) {
      throw new Error((json as ApiErrorResponse).error || `HTTP ${response.status}`);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  // ========== Auth / Profile ==========

  async getProfile(): Promise<AdminUser> {
    return this.request<AdminUser>('GET', '/api/admin/auth/profile');
  }

  // ========== Admin Users ==========

  async createAdmin(data: {
    email: string;
    displayName: string;
    department?: string;
    role?: EnliteRole;
  }): Promise<AdminUser & { resetLink?: string }> {
    return this.request<AdminUser & { resetLink?: string }>('POST', '/api/admin/users', data);
  }

  async updateAdminRole(firebaseUid: string, role: EnliteRole, department?: string): Promise<AdminUser> {
    return this.request<AdminUser>('PATCH', `/api/admin/users/${firebaseUid}/role`, {
      role,
      ...(department !== undefined ? { department } : {}),
    });
  }

  async listAdmins(limit = 50, offset = 0): Promise<{ admins: AdminUser[]; total: number }> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/users?limit=${limit}&offset=${offset}`, { headers });
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { admins: json.data as AdminUser[], total: json.pagination?.total ?? json.data.length };
  }

  async deleteAdmin(firebaseUid: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/admin/users/${firebaseUid}`);
  }

  async resetPassword(firebaseUid: string): Promise<{ resetLink: string; message: string }> {
    return this.request<{ resetLink: string; message: string }>(
      'POST', `/api/admin/users/${firebaseUid}/reset-password`,
    );
  }

  async getCasesForSelect(): Promise<{ caseNumber: number; patientId: string; dependencyLevel: string }[]> {
    return this.request<{ caseNumber: number; patientId: string; dependencyLevel: string }[]>(
      'GET', '/api/admin/vacancies/cases-for-select',
    );
  }

  // ========== Vacancy AI Parsing — delegated to AdminVacancyParseApiService ==========

  createPatientAddress(patientId: string, data: PatientAddressCreateInput): Promise<PatientAddressRow> {
    return AdminVacancyParseApiService.createPatientAddress(patientId, data);
  }

  // ========== Vacancies Methods ==========

  async listVacancies(filters?: {
    search?: string; client?: string; status?: string; priority?: string; limit?: string; offset?: string;
  }): Promise<{ data: any[]; total: number }> {
    const params = new URLSearchParams(filters as any);
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/vacancies?${params}`, { method: 'GET', headers });
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data, total: json.total };
  }

  async getVacanciesStats(): Promise<any[]> {
    return this.request<any[]>('GET', '/api/admin/vacancies/stats');
  }

  async getNextVacancyNumber(): Promise<number> {
    const data = await this.request<{ nextVacancyNumber: number }>('GET', '/api/admin/vacancies/next-vacancy-number');
    return data.nextVacancyNumber;
  }

  async getVacancyById(id: string): Promise<any> {
    return this.request<any>('GET', `/api/admin/vacancies/${id}`);
  }

  async createVacancy(data: any): Promise<any> {
    return this.request<any>('POST', '/api/admin/vacancies', data);
  }

  async updateVacancy(id: string, data: any): Promise<any> {
    return this.request<any>('PUT', `/api/admin/vacancies/${id}`, data);
  }

  async deleteVacancy(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/admin/vacancies/${id}`);
  }

  async updateVacancyMeetLinks(
    vacancyId: string,
    meetLinks: [string | null, string | null, string | null],
  ): Promise<{
    meet_link_1: string | null; meet_datetime_1: string | null;
    meet_link_2: string | null; meet_datetime_2: string | null;
    meet_link_3: string | null; meet_datetime_3: string | null;
  }> {
    return this.request<{
      meet_link_1: string | null; meet_datetime_1: string | null;
      meet_link_2: string | null; meet_datetime_2: string | null;
      meet_link_3: string | null; meet_datetime_3: string | null;
    }>('PUT', `/api/admin/vacancies/${vacancyId}/meet-links`, { meet_links: meetLinks });
  }

  /**
   * Resolve the start datetime of a Google Meet link via Calendar API
   * without persisting anything. Reuses the same `resolveDateTime` routine
   * used by the PUT meet-links endpoint, but exposed for on-blur preview
   * before the vacancy exists.
   */
  async lookupMeetDatetime(meetLink: string): Promise<{ datetime: string | null; normalized: string }> {
    return this.request<{ datetime: string | null; normalized: string }>(
      'POST',
      '/api/admin/vacancies/meet-links/lookup',
      { link: meetLink },
    );
  }

  // ========== Match Methods ==========

  async getMatchResults(vacancyId: string, limit = 50, offset = 0): Promise<MatchResultsResponse> {
    return this.request<MatchResultsResponse>(
      'GET',
      `/api/admin/vacancies/${vacancyId}/match-results?limit=${limit}&offset=${offset}`
    );
  }

  async triggerMatch(
    vacancyId: string,
    options?: { topN?: number; radiusKm?: number; excludeActive?: boolean }
  ): Promise<MatchResultsResponse> {
    const params = new URLSearchParams();
    if (options?.topN       !== undefined) params.set('top_n',         String(options.topN));
    if (options?.radiusKm   !== undefined) params.set('radius_km',     String(options.radiusKm));
    if (options?.excludeActive)            params.set('exclude_active', 'true');
    const qs = params.toString();
    return this.request<MatchResultsResponse>('POST', `/api/admin/vacancies/${vacancyId}/match${qs ? `?${qs}` : ''}`);
  }

  async sendWhatsApp(
    workerId: string,
    templateSlug: string,
    variables: Record<string, string>,
    jobPostingId?: string
  ): Promise<WhatsAppSentResult> {
    return this.request<WhatsAppSentResult>('POST', '/api/admin/messaging/whatsapp', {
      workerId, templateSlug, variables, ...(jobPostingId ? { jobPostingId } : {}),
    });
  }

  async getMessageTemplates(): Promise<MessageTemplate[]> {
    return this.request<MessageTemplate[]>('GET', '/api/admin/messaging/templates');
  }

  // ========== Workers Methods ==========

  async listCaseOptions(): Promise<{ value: string; label: string }[]> {
    return this.request<{ value: string; label: string }[]>('GET', '/api/admin/workers/case-options');
  }

  async listWorkers(filters?: {
    platform?: string;
    docs_complete?: string;
    docs_validated?: 'all_validated' | 'pending_validation';
    search?: string;
    case_id?: string;
    limit?: string;
    offset?: string;
  }): Promise<{ data: any[]; total: number }> {
    const cleanFilters = Object.fromEntries(
      Object.entries(filters ?? {}).filter(([, v]) => v !== undefined && v !== ''),
    );
    const params = new URLSearchParams(cleanFilters as Record<string, string>);
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/workers?${params}`, { method: 'GET', headers });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data ?? [], total: json.total ?? 0 };
  }

  async getWorkerById(id: string): Promise<WorkerDetail> {
    return this.request<WorkerDetail>('GET', `/api/admin/workers/${id}`);
  }

  async getWorkerDateStats(): Promise<WorkerDateStats> {
    return this.request<WorkerDateStats>('GET', '/api/admin/workers/stats');
  }

  // ========== Patients Methods — delegated to AdminPatientsApiService ==========
  listPatients(f?: Parameters<typeof AdminPatientsApiService.listPatients>[0]) { return AdminPatientsApiService.listPatients(f); }
  getPatientStats() { return AdminPatientsApiService.getPatientStats(); }
  getPatientById(id: string) { return AdminPatientsApiService.getPatientById(id); }
  searchPatients(search: string, limit = 10) { return AdminPatientsApiService.listPatients({ search, limit: String(limit) }); }
  getPatientByIdFull(id: string) { return AdminPatientsApiService.getPatientById(id); }

  // ========== Encuadres Methods ==========

  async updateEncuadreResult(
    encuadreId: string,
    data: { resultado: string; rejectionReasonCategory?: string; rejectionReason?: string }
  ): Promise<void> {
    await this.request<unknown>('PUT', `/api/admin/encuadres/${encuadreId}/result`, data);
  }

  async getEncuadreFunnel(vacancyId: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/admin/vacancies/${vacancyId}/funnel`);
  }

  async moveEncuadre(
    encuadreId: string,
    data: { targetStage: string; rejectionReasonCategory?: string; rejectionReason?: string }
  ): Promise<void> {
    await this.request<unknown>('PUT', `/api/admin/encuadres/${encuadreId}/move`, data);
  }

  async getVacancyFunnelTable(
    vacancyId: string,
    bucket?: 'INVITED' | 'POSTULATED' | 'PRE_SELECTED' | 'REJECTED' | 'WITHDREW' | 'ALL',
  ): Promise<import('@domain/entities/Funnel').FunnelTableResponse> {
    const qs = bucket ? `?bucket=${bucket}` : '';
    return this.request<import('@domain/entities/Funnel').FunnelTableResponse>(
      'GET',
      `/api/admin/vacancies/${vacancyId}/funnel-table${qs}`,
    );
  }

  // ========== Interview Slots Methods ==========

  async createInterviewSlots(vacancyId: string, data: CreateSlotsInput): Promise<InterviewSlot[]> {
    return this.request<InterviewSlot[]>('POST', `/api/admin/vacancies/${vacancyId}/interview-slots`, data);
  }

  async getInterviewSlots(
    vacancyId: string, status?: string,
  ): Promise<{ slots: InterviewSlot[]; summary: InterviewSlotsSummary }> {
    const qs = status ? `?status=${status}` : '';
    return this.request<{ slots: InterviewSlot[]; summary: InterviewSlotsSummary }>(
      'GET', `/api/admin/vacancies/${vacancyId}/interview-slots${qs}`,
    );
  }

  async bookInterviewSlot(
    slotId: string, data: { encuadreId: string; sendInvitation?: boolean },
  ): Promise<BookSlotResult> {
    return this.request<BookSlotResult>('POST', `/api/admin/interview-slots/${slotId}/book`, data);
  }

  async cancelInterviewSlot(slotId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/admin/interview-slots/${slotId}`);
  }

  // ========== Worker Sync ==========

  async syncTalentumWorkers(): Promise<{
    total: number; created: number; updated: number; skipped: number; linked: number;
    errors: Array<{ profileId: string; name: string; error: string }>;
  }> {
    return this.request('POST', '/api/admin/workers/sync-talentum');
  }

  // ========== Talentum + AI — delegated to AdminTalentumApiService ==========
  syncFromTalentum(opts?: { force?: boolean }) { return AdminTalentumApiService.syncFromTalentum(opts); }
  publishToTalentum(vacancyId: string) { return AdminTalentumApiService.publishToTalentum(vacancyId); }
  unpublishFromTalentum(vacancyId: string) { return AdminTalentumApiService.unpublishFromTalentum(vacancyId); }
  generateAIContent(vacancyId: string) { return AdminTalentumApiService.generateAIContent(vacancyId); }
  generateSocialLink(vacancyId: string, channel: 'facebook' | 'instagram' | 'whatsapp' | 'linkedin' | 'site') {
    return AdminTalentumApiService.generateSocialLink(vacancyId, channel);
  }
  getSocialLinksStats(vacancyId: string) { return AdminTalentumApiService.getSocialLinksStats(vacancyId); }

  // ========== Prescreening Config ==========

  async getPrescreeningConfig(vacancyId: string): Promise<{ questions: any[]; faq: any[] }> {
    return this.request<{ questions: any[]; faq: any[] }>('GET', `/api/admin/vacancies/${vacancyId}/prescreening-config`);
  }

  async savePrescreeningConfig(
    vacancyId: string, data: { questions: any[]; faq: any[] }
  ): Promise<{ questions: any[]; faq: any[] }> {
    return this.request<{ questions: any[]; faq: any[] }>(
      'POST', `/api/admin/vacancies/${vacancyId}/prescreening-config`, data,
    );
  }

  // ========== Worker Document methods — delegated to AdminWorkerDocsApiService ==========
  getWorkerDocUploadUrl(w: string, d: string, c: string) { return AdminWorkerDocsApiService.getWorkerDocUploadUrl(w, d, c); }
  saveWorkerDocPath(w: string, d: string, f: string): Promise<WorkerDocument> { return AdminWorkerDocsApiService.saveWorkerDocPath(w, d, f); }
  getWorkerDocViewUrl(w: string, f: string): Promise<string> { return AdminWorkerDocsApiService.getWorkerDocViewUrl(w, f); }
  deleteWorkerDoc(w: string, d: string): Promise<WorkerDocument> { return AdminWorkerDocsApiService.deleteWorkerDoc(w, d); }
  validateWorkerDoc(w: string, d: string): Promise<DocumentValidations> { return AdminWorkerDocsApiService.validateWorkerDoc(w, d); }
  invalidateWorkerDoc(w: string, d: string): Promise<DocumentValidations> { return AdminWorkerDocsApiService.invalidateWorkerDoc(w, d); }
  uploadWorkerDocToGCS(url: string, file: File): Promise<void> { return AdminWorkerDocsApiService.uploadWorkerDocToGCS(url, file); }
  getWorkerAdditionalDocs(w: string): Promise<AdminAdditionalDocument[]> { return AdminWorkerDocsApiService.getWorkerAdditionalDocs(w); }
  getWorkerAdditionalDocUploadUrl(w: string, c: string) { return AdminWorkerDocsApiService.getWorkerAdditionalDocUploadUrl(w, c); }
  saveWorkerAdditionalDoc(w: string, l: string, f: string): Promise<AdminAdditionalDocument> { return AdminWorkerDocsApiService.saveWorkerAdditionalDoc(w, l, f); }
  deleteWorkerAdditionalDoc(w: string, id: string): Promise<void> { return AdminWorkerDocsApiService.deleteWorkerAdditionalDoc(w, id); }

  // ========== Pending Address Review — delegated to AdminVacancyAddressApiService ==========
  listPendingAddressReview(statusFilter?: string) { return AdminVacancyAddressApiService.listPendingAddressReview(statusFilter); }
  resolveAddressReview(vacancyId: string, body: ResolveAddressBody) { return AdminVacancyAddressApiService.resolveAddressReview(vacancyId, body); }
  listPatientAddresses(patientId: string) { return AdminVacancyAddressApiService.listPatientAddresses(patientId); }
}

export const AdminApiService = new AdminApiServiceClass();
