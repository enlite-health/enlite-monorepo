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
interface ApiErrorResponse { success: false; error: string; details?: string }
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

const authService = new FirebaseAuthService();
const baseURL = (): string =>
  (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';

// Direct Cloud Run URL — bypasses Firebase Hosting's 60s rewrite timeout.
// Used only by long-running endpoints (Gemini calls etc.). Falls back to baseURL.
const directBaseURL = (): string =>
  (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_DIRECT_URL || baseURL();

async function getHeaders(): Promise<Record<string, string>> {
  const token = await authService.getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown, opts?: { useDirectURL?: boolean }): Promise<T> {
  const headers = await getHeaders();
  const base = opts?.useDirectURL ? directBaseURL() : baseURL();
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: ApiResponse<T> = await response.json();
  if (!json.success) {
    const err = json as ApiErrorResponse;
    // Surface the backend `details` (real cause) instead of only the generic
    // `error` — e.g. "Failed to generate AI content: Vertex AI: could not
    // obtain an ADC access token". Operators were blind to the actual reason.
    const base = err.error || `HTTP ${response.status}`;
    throw new Error(err.details ? `${base}: ${err.details}` : base);
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

  // ========== Description (manual edit) ==========

  /**
   * Persiste a descrição EDITADA MANUALMENTE. Se a vaga já estiver publicada no
   * Talentum, o backend propaga a edição in-place (retorna propagated=true).
   * Usa a URL direta (bypassa o timeout de 60s do Hosting) porque o backend fala
   * com a API externa do Talentum (GET + PUT).
   */
  async updateTalentumDescription(
    vacancyId: string,
    description: string,
  ): Promise<{ description: string; propagated: boolean }> {
    return request<{ description: string; propagated: boolean }>(
      'PUT',
      `/api/admin/vacancies/${vacancyId}/talentum-description`,
      { description },
      { useDirectURL: true },
    );
  },

  // ========== AI Content Generation ==========

  async generateAIContent(vacancyId: string): Promise<AIContentResult> {
    return request<AIContentResult>(
      'POST',
      `/api/admin/vacancies/${vacancyId}/generate-ai-content`,
      undefined,
      { useDirectURL: true },
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
