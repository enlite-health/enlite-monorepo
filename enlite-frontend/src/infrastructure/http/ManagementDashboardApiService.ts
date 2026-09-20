import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

/**
 * Cliente do endpoint read-only GET /analytics/dashboard/management.
 * Prefixo /analytics (não /api/admin/recruitment) — segue o mesmo mount dos
 * demais dashboards de analytics no worker-functions.
 */
export const ManagementDashboardApiService = {
  /**
   * @param funnelPeriodDays filtro por ENTRADA no funil por prestador (7/30/90; null = tudo).
   * @param country PR-9 (`lex` #9): 'AR'|'BR'|'ALL'. Ausente/null = ALL (resolvido no
   *   servidor como a união dos países do ator — nunca "todos os países do sistema").
   */
  async getManagementDashboard(
    funnelPeriodDays: 7 | 30 | 90 | null = null,
    country: string | null = null,
  ): Promise<ManagementDashboardData> {
    const token = await authService.getIdToken();
    const params = new URLSearchParams();
    if (funnelPeriodDays != null) params.set('funnelPeriodDays', String(funnelPeriodDays));
    if (country) params.set('country', country);
    const query = params.toString() ? `?${params.toString()}` : '';
    const resp = await fetch(`${getBaseURL()}/analytics/dashboard/management${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const json = (await resp.json()) as {
      success: boolean;
      data?: ManagementDashboardData;
      error?: string;
      /** PR-9: 403 COUNTRY_SCOPE_REQUIRED / 400 INVALID_COUNTRY vêm com detalhe legível. */
      detail?: string;
    };
    if (!json.success || !json.data) {
      throw new Error(json.detail ?? json.error ?? `HTTP ${resp.status}`);
    }
    return json.data;
  },
};
