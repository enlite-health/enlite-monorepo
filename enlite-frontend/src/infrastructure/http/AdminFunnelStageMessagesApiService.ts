/**
 * AdminFunnelStageMessagesApiService — config "mensagem por etapa" do Kanban (DEC-12 / PEND-14).
 * Serviço próprio (mesmo padrão do AdminRecruitmentApiService) para não engordar o AdminApiService.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export interface FunnelStageMessageRow { stage: string; templateSlug: string | null; enabled: boolean; channel: string; builtin: string | null; updatedBy: string | null; updatedAt: string | null }
/**
 * `body`      — contrato de ENVIO: placeholders nomeados, na ordem em que viram
 *               as contentVariables posicionais da Twilio.
 * `bodyTwilio` — texto aprovado na Meta, só EXIBIÇÃO (posicional). `null` = nunca
 *               sincronizado; a tela diz que não sabe em vez de inventar.
 */
export interface FunnelStageTemplateOption { slug: string; name: string; body: string | null; bodyTwilio: string | null; category: string | null; eligible: boolean; reason: string | null; placeholders: string[]; unsupported: string[] }
export interface FunnelStageMessagesConfig { country: string; stages: FunnelStageMessageRow[]; templates: FunnelStageTemplateOption[] }
export interface FunnelStageMessageUpdate { stage: string; templateSlug: string | null; enabled: boolean }

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

export const AdminFunnelStageMessagesApiService = {
  async getFunnelStageMessages(): Promise<FunnelStageMessagesConfig> {
    return request<FunnelStageMessagesConfig>('GET', '/api/admin/funnel-stage-messages');
  },

  /** Só admin. `templateSlug` null desliga a etapa. Corpo em snake_case (zod strict no backend). */
  async updateFunnelStageMessage(stage: string, body: { templateSlug: string | null; enabled: boolean }): Promise<FunnelStageMessageUpdate> {
    return request<FunnelStageMessageUpdate>('PUT', `/api/admin/funnel-stage-messages/${stage}`, { template_slug: body.templateSlug, enabled: body.enabled });
  },
};
