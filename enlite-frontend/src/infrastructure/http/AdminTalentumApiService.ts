/**
 * AdminTalentumApiService
 *
 * Handles all Talentum-related API calls:
 *   - Sync from Talentum
 *   - Publish / unpublish to Talentum
 *   - Generate AI content (description + prescreening)
 *   - Social short links
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface AIContentQuestion {
  question: string;
  responseType: string[];
  desiredResponse: string;
  weight: number;
  required: boolean;
  analyzed: boolean;
  earlyStoppage: boolean;
}

export interface AIContentFaqItem {
  question: string;
  answer: string;
}

export interface AIContentResult {
  description: string;
  prescreening: {
    questions: AIContentQuestion[];
    faq: AIContentFaqItem[];
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ApiSuccessResponse<T> { success: true; data: T }
interface ApiErrorResponse { success: false; error: string }
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

const authService = new FirebaseAuthService();
const baseURL = (): string =>
  (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';

async function getHeaders(): Promise<Record<string, string>> {
  const token = await authService.getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getHeaders();
  const response = await fetch(`${baseURL()}${path}`, {
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const AdminTalentumApiService = {
  // ========== Sync ==========

  async syncFromTalentum(opts?: { force?: boolean }): Promise<{
    total: number; updated: number; created: number; skipped: number;
    errors: Array<{ projectId: string; title: string; error: string }>;
  }> {
    const qs = opts?.force ? '?force=true' : '';
    return request('POST', `/api/admin/vacancies/sync-talentum${qs}`);
  },

  // ========== Publish / Unpublish ==========

  async publishToTalentum(
    vacancyId: string,
  ): Promise<{ projectId: string; publicId: string; whatsappUrl: string }> {
    return request<{ projectId: string; publicId: string; whatsappUrl: string }>(
      'POST', `/api/admin/vacancies/${vacancyId}/publish-talentum`,
    );
  },

  async unpublishFromTalentum(vacancyId: string): Promise<void> {
    await request<unknown>('DELETE', `/api/admin/vacancies/${vacancyId}/publish-talentum`);
  },

  // ========== AI Content Generation ==========

  async generateAIContent(vacancyId: string): Promise<AIContentResult> {
    return request<AIContentResult>(
      'POST',
      `/api/admin/vacancies/${vacancyId}/generate-ai-content`,
    );
  },

  // ========== Social Short Links ==========

  async generateSocialLink(
    vacancyId: string,
    channel: 'facebook' | 'instagram' | 'whatsapp' | 'linkedin' | 'site',
  ): Promise<{
    channel: string;
    shortURL: string;
    social_short_links: Record<string, { url: string; id: string }>;
  }> {
    return request('POST', `/api/admin/vacancies/${vacancyId}/social-links`, { channel });
  },

  async getSocialLinksStats(
    vacancyId: string,
  ): Promise<Record<string, { url: string; clicks: number }>> {
    return request('GET', `/api/admin/vacancies/${vacancyId}/social-links-stats`);
  },
};
