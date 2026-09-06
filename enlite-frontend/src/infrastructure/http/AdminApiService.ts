import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { AdminUser } from '@domain/entities/AdminUser';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { WorkerDateStats, WorkerDetail, WorkerDocument, DocumentValidations, WorkerProfileUpdatePayload, WorkerProfileUpdateResult, WorkerServiceAreaUpdatePayload } from '@domain/entities/Worker';
import type { MatchResultsResponse } from '../../types/match';
import type { InterviewSlot, CreateSlotsInput, BookSlotResult, InterviewSlotsSummary } from '@domain/entities/InterviewSlot';
import {
  AdminWorkerDocsApiService,
  type AdminAdditionalDocument,
} from './AdminWorkerDocsApiService';
import { AdminPatientsApiService } from './AdminPatientsApiService';
import { AdminVacancyParseApiService } from './AdminVacancyParseApiService';
import {
  AdminVacancyAddressApiService,
  type ResolveAddressBody,
} from './AdminVacancyAddressApiService';
import { AdminMessagingApiService } from './AdminMessagingApiService';
import {
  AdminTalentumApiService,
  type AIContentResult,
} from './AdminTalentumApiService';
import { AdminVacancyDraftsApiService } from './AdminVacancyDraftsApiService';
import { AdminContactNotesApiService } from './AdminContactNotesApiService';
import {
  AdminVacancyListApiService,
  type VacancyListFilters,
  type VacancyFilterOptions,
} from './AdminVacancyListApiService';
import type { VacancyDraftSummary, VacancyByAddressSummary } from '@domain/entities/VacancyDraft';
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
export type { VacancyDraftSummary, VacancyByAddressSummary };

import { AdminWorkerTagsApiService } from './AdminWorkerTagsApiService';
import {
  AdminWorkerListApiService,
  type WorkerListFilters,
  type WorkerFilterOptions,
} from './AdminWorkerListApiService';
export type { WorkerListFilters, WorkerFilterOptions };
import { ApiError, ApiResponse, ApiSuccessResponse, ApiErrorResponse } from './ApiError';
import { withTransientRetry } from './retryTransient';

/** Slot recorrente da reunión de presentación (mig 291). */
export interface RecurringMeetSlot { weekday: number; time: string; link: string }
export { ApiError } from './ApiError';

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
      throw new ApiError(json as ApiErrorResponse, response.status);
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  // ========== Auth / Profile ==========

  async getProfile(): Promise<AdminUser> {
    return withTransientRetry(() => this.request<AdminUser>('GET', '/api/admin/auth/profile'));
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

  // ========== Vacancies List — delegated to AdminVacancyListApiService ==========
  listVacancies(f?: VacancyListFilters): Promise<{ data: unknown[]; total: number }> {
    return AdminVacancyListApiService.listVacancies(f);
  }
  getVacancyFilterOptions(): Promise<VacancyFilterOptions> {
    return AdminVacancyListApiService.getVacancyFilterOptions();
  }

  // ========== Vacancies Methods ==========

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

  /**
   * `recurring` (mig 291): omitido = não mexe; `null` = limpa; objeto = grava
   * {weekday 0..6, time 'HH:MM' LOCAL da vaga, link da sala}.
   */
  async updateVacancyMeetLinks(
    vacancyId: string,
    meetLinks: [string | null, string | null, string | null],
    recurring?: RecurringMeetSlot | null,
  ): Promise<{
    meet_link_1: string | null; meet_datetime_1: string | null;
    meet_link_2: string | null; meet_datetime_2: string | null;
    meet_link_3: string | null; meet_datetime_3: string | null;
    meet_recurring?: RecurringMeetSlot | null;
  }> {
    return this.request<{
      meet_link_1: string | null; meet_datetime_1: string | null;
      meet_link_2: string | null; meet_datetime_2: string | null;
      meet_link_3: string | null; meet_datetime_3: string | null;
      meet_recurring?: RecurringMeetSlot | null;
    }>('PUT', `/api/admin/vacancies/${vacancyId}/meet-links`, {
      meet_links: meetLinks,
      ...(recurring !== undefined ? { recurring } : {}),
    });
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

  // ========== Messaging Methods — delegated to AdminMessagingApiService ==========
  sendVacancyMatchInvite(
    ...args: Parameters<typeof AdminMessagingApiService.sendVacancyMatchInvite>
  ) {
    return AdminMessagingApiService.sendVacancyMatchInvite(...args);
  }

  // ========== Workers Methods — listing delegated to AdminWorkerListApiService ==========

  listCaseOptions() { return AdminWorkerListApiService.listCaseOptions(); }
  getWorkerFilterOptions() { return AdminWorkerListApiService.getWorkerFilterOptions(); }
  listWorkers(f?: WorkerListFilters) { return AdminWorkerListApiService.listWorkers(f); }

  async getWorkerById(id: string): Promise<WorkerDetail> {
    return this.request<WorkerDetail>('GET', `/api/admin/workers/${id}`);
  }

  async getWorkerDateStats(): Promise<WorkerDateStats> {
    return this.request<WorkerDateStats>('GET', '/api/admin/workers/stats');
  }

  /** Marca/desmarca um worker como conta de teste (admin-only no backend). */
  async updateWorkerTestFlag(id: string, isTest: boolean): Promise<{ isTest: boolean }> {
    return this.request<{ isTest: boolean }>('PATCH', `/api/admin/workers/${id}/test-flag`, { isTest });
  }

  /** Edita campos do perfil de um worker (admin-only no backend). */
  async updateWorkerProfile(id: string, payload: WorkerProfileUpdatePayload): Promise<WorkerProfileUpdateResult> {
    return this.request<WorkerProfileUpdateResult>('PATCH', `/api/admin/workers/${id}/profile`, payload);
  }

  /** Edita o endereço/área de serviço de um worker (admin-only no backend). */
  async updateWorkerServiceArea(id: string, payload: WorkerServiceAreaUpdatePayload): Promise<void> {
    await this.request<unknown>('PUT', `/api/admin/workers/${id}/service-area`, payload);
  }

  // ========== Patients Methods — delegated to AdminPatientsApiService ==========
  listPatients(f?: Parameters<typeof AdminPatientsApiService.listPatients>[0]) { return AdminPatientsApiService.listPatients(f); }
  getPatientStats() { return AdminPatientsApiService.getPatientStats(); }
  getPatientById(id: string) { return AdminPatientsApiService.getPatientById(id); }
  searchPatients(search: string, limit = 10) { return AdminPatientsApiService.listPatients({ search, limit: String(limit) }); }
  getPatientByIdFull(id: string) { return AdminPatientsApiService.getPatientById(id); }
  getPatientVacancies(patientId: string) { return AdminPatientsApiService.getPatientVacancies(patientId); }
  createPatient(payload: Parameters<typeof AdminPatientsApiService.createPatient>[0]) { return AdminPatientsApiService.createPatient(payload); }
  updatePatientSection(...args: Parameters<typeof AdminPatientsApiService.updatePatientSection>) { return AdminPatientsApiService.updatePatientSection(...args); }
  updatePatientStatus(...args: Parameters<typeof AdminPatientsApiService.updatePatientStatus>) { return AdminPatientsApiService.updatePatientStatus(...args); }
  getPatientStatusHistory(id: string) { return AdminPatientsApiService.getPatientStatusHistory(id); }
  listInsuranceProviders() { return AdminPatientsApiService.listInsuranceProviders(); }
  updatePatientAddressLogistics(...args: Parameters<typeof AdminPatientsApiService.updatePatientAddressLogistics>) { return AdminPatientsApiService.updatePatientAddressLogistics(...args); }
  getPatientChatCandidates(id: string, limit?: number) { return AdminPatientsApiService.getPatientChatCandidates(id, limit); }
  updatePatientChatIds(...args: Parameters<typeof AdminPatientsApiService.updatePatientChatIds>) { return AdminPatientsApiService.updatePatientChatIds(...args); }
  listChatGroups(...args: Parameters<typeof AdminPatientsApiService.listChatGroups>) { return AdminPatientsApiService.listChatGroups(...args); }
  listPatientChatRoles(includeInactive?: boolean) { return AdminPatientsApiService.listPatientChatRoles(includeInactive); }
  createPatientChatRole(...args: Parameters<typeof AdminPatientsApiService.createPatientChatRole>) { return AdminPatientsApiService.createPatientChatRole(...args); }
  updatePatientChatRole(...args: Parameters<typeof AdminPatientsApiService.updatePatientChatRole>) { return AdminPatientsApiService.updatePatientChatRole(...args); }
  deletePatientChatRole(code: string) { return AdminPatientsApiService.deletePatientChatRole(code); }
  activatePatient(id: string) { return AdminPatientsApiService.activatePatient(id); }
  listPatientsForKanban(country?: string) { return AdminPatientsApiService.listPatientsForKanban(country); }
  getPatientFunnel(p?: Parameters<typeof AdminPatientsApiService.getPatientFunnel>[0]) { return AdminPatientsApiService.getPatientFunnel(p); }

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
    data: {
      targetStage: string;
      rejectionReasonCategory?: string;
      rejectionReason?: string;
      role?: 'TITULAR' | 'RAPID_RESPONSE';
      /** Data (YYYY-MM-DD) e hora (HH:MM) locais da operação; o servidor converte o fuso. */
      interviewDate?: string;
      interviewTime?: string;
      interviewMeetLink?: string;
    }
  ): Promise<void> {
    await this.request<unknown>('PUT', `/api/admin/encuadres/${encuadreId}/move`, data);
  }

  /**
   * "Rechazar" um card BLOQUEADO: promove a tentativa bloqueada daquela vaga para
   * RECHAZADOS (com motivo). Escopo estrito à vaga — não afeta o cadastro nem outras vagas.
   */
  async rejectBlockedAttempt(
    blockedId: string,
    data: { rejectionReasonCategory: string; rejectionReason?: string },
  ): Promise<void> {
    await this.request<unknown>('POST', `/api/admin/vacancies/blocked-applications/${blockedId}/reject`, data);
  }

  /** "Voltar a bloqueados": desfaz o rechazo de um card bloqueado (RECHAZADOS → BLOQUEADO). */
  async restoreBlockedAttempt(blockedId: string): Promise<void> {
    await this.request<unknown>('POST', `/api/admin/vacancies/blocked-applications/${blockedId}/restore`);
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

  // ========== Contact Notes — delegated to AdminContactNotesApiService ==========
  getContactNotes(...args: Parameters<typeof AdminContactNotesApiService.getContactNotes>) {
    return AdminContactNotesApiService.getContactNotes(...args);
  }
  createContactNote(...args: Parameters<typeof AdminContactNotesApiService.createContactNote>) {
    return AdminContactNotesApiService.createContactNote(...args);
  }
  deleteContactNote(...args: Parameters<typeof AdminContactNotesApiService.deleteContactNote>) {
    return AdminContactNotesApiService.deleteContactNote(...args);
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
  updateTalentumDescription(vacancyId: string, description: string) {
    return AdminTalentumApiService.updateTalentumDescription(vacancyId, description);
  }
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

  // ========== Vacancy Drafts — delegated to AdminVacancyDraftsApiService ==========
  listDraftsForPatient(patientId: string): Promise<VacancyDraftSummary[]> { return AdminVacancyDraftsApiService.listDraftsForPatient(patientId); }
  listVacanciesByAddress(patientAddressId: string): Promise<VacancyByAddressSummary[]> { return AdminVacancyDraftsApiService.listByAddress(patientAddressId); }

  // ========== Worker Tags — delegated to AdminWorkerTagsApiService ==========
  listWorkerTags() { return AdminWorkerTagsApiService.listWorkerTags(); }
  createWorkerTag(...args: Parameters<typeof AdminWorkerTagsApiService.createWorkerTag>) { return AdminWorkerTagsApiService.createWorkerTag(...args); }
  updateWorkerTag(...args: Parameters<typeof AdminWorkerTagsApiService.updateWorkerTag>) { return AdminWorkerTagsApiService.updateWorkerTag(...args); }
  deleteWorkerTag(id: string) { return AdminWorkerTagsApiService.deleteWorkerTag(id); }
  assignTagToWorker(workerId: string, tagId: string) { return AdminWorkerTagsApiService.assignTagToWorker(workerId, tagId); }
  removeTagFromWorker(workerId: string, tagId: string) { return AdminWorkerTagsApiService.removeTagFromWorker(workerId, tagId); }
}
export const AdminApiService = new AdminApiServiceClass();
