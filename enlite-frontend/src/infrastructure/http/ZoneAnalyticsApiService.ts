import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { ZoneAnalyticsData } from '@domain/entities/ZoneAnalytics';
import type { WorkerProfession } from '@domain/entities/Worker';

const authService = new FirebaseAuthService();

function getBaseURL(): string {
  return (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

/**
 * Cliente do endpoint read-only GET /analytics/dashboard/zone-analytics.
 * Mesmo mount /analytics dos demais dashboards de analytics (ver
 * ManagementDashboardApiService). Aceita filtro opcional de profession —
 * mesmo enum canônico de WORKER_PROFESSIONS (AT/CAREGIVER/NURSE/
 * KINESIOLOGIST/PSYCHOLOGIST) — dimensão mínima de BI pedida pra essa seção.
 */
export const ZoneAnalyticsApiService = {
  async getZoneAnalytics(profession?: WorkerProfession): Promise<ZoneAnalyticsData> {
    const token = await authService.getIdToken();
    const query = profession ? `?profession=${encodeURIComponent(profession)}` : '';
    const resp = await fetch(`${getBaseURL()}/analytics/dashboard/zone-analytics${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const json = (await resp.json()) as {
      success: boolean;
      data?: ZoneAnalyticsData;
      error?: string;
    };
    if (!json.success || !json.data) {
      throw new Error(json.error ?? `HTTP ${resp.status}`);
    }
    return json.data;
  },
};
