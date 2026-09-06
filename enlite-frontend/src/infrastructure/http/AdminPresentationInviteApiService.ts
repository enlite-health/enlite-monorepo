/**
 * AdminPresentationInviteApiService — convite à reunión de presentación (REQ-09).
 * Serviço próprio (padrão do AdminRecruitmentApiService): o AdminApiService já passa do teto de linhas.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface PresentationTemplateOption { slug: string; name: string; category: string | null; eligible: boolean; reason: string | null; placeholders: string[]; unsupported: string[] }
export interface PresentationInviteSettings {
  country: string; templateSlug: string | null; meetLink: string | null; scheduleLabel: string | null; enabled: boolean;
  updatedBy: string | null; updatedAt: string | null; templates: PresentationTemplateOption[];
}
export interface PresentationInviteSettingsBody { templateSlug: string | null; meetLink: string | null; scheduleLabel: string | null; enabled: boolean }
export type PresentationInviteResult = { status: 'queued'; outboxId: string } | { status: 'skipped'; skipReason: string };
export type PresentationInviteLast = Record<string, { at: string; by: string | null }>;
export interface PresentationInviteStats { windowDays: number; rows: Array<{ status: string; skipReason: string | null; source: string; count: number }>; attended: number }

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as { env?: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await authService.getIdToken();
  const response = await fetch(`${getBaseURL()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json.data as T;
}

export const AdminPresentationInviteApiService = {
  getSettings(): Promise<PresentationInviteSettings> {
    return request<PresentationInviteSettings>('GET', '/api/admin/presentation-invite/settings');
  },
  /** Só admin. Corpo em snake_case (zod strict no backend). */
  updateSettings(b: PresentationInviteSettingsBody): Promise<PresentationInviteSettingsBody> {
    return request<PresentationInviteSettingsBody>('PUT', '/api/admin/presentation-invite/settings', {
      template_slug: b.templateSlug, meet_link: b.meetLink, schedule_label: b.scheduleLabel, enabled: b.enabled,
    });
  },
  invite(workerId: string, source: 'kanban' | 'workers_list', jobPostingId?: string | null): Promise<PresentationInviteResult> {
    return request<PresentationInviteResult>('POST', `/api/admin/workers/${workerId}/presentation-invite`, { source, job_posting_id: jobPostingId ?? null });
  },
  last(workerIds: string[]): Promise<PresentationInviteLast> {
    if (workerIds.length === 0) return Promise.resolve({});
    return request<PresentationInviteLast>('GET', `/api/admin/presentation-invite/last?workerIds=${encodeURIComponent(workerIds.join(','))}`);
  },
  stats(): Promise<PresentationInviteStats> {
    return request<PresentationInviteStats>('GET', '/api/admin/presentation-invite/stats');
  },
};
