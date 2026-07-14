import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ZoneAnalyticsApiService } from '../ZoneAnalyticsApiService';

// ── Mock FirebaseAuthService ───────────────────────────────────────────────────

const { getIdToken } = vi.hoisted(() => ({
  getIdToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken,
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: async () => body,
  });
}

function capturedUrl(): string {
  return (global.fetch as Mock).mock.calls[0][0] as string;
}

function capturedOptions(): RequestInit {
  return (global.fetch as Mock).mock.calls[0][1] as RequestInit;
}

const ZONE_DATA = {
  zones: [
    { zone: 'Palermo', patients: 10, workersMale: 3, workersFemale: 5, demand: 12, availability: 8 },
  ],
  unresolvedCount: 0,
};

describe('ZoneAnalyticsApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIdToken.mockResolvedValue('mock-token');
  });

  describe('getZoneAnalytics', () => {
    it('monta ?profession=<valor> com encodeURIComponent quando profession é passado', async () => {
      mockFetch({ success: true, data: ZONE_DATA });

      await ZoneAnalyticsApiService.getZoneAnalytics('CAREGIVER');

      expect(capturedUrl()).toContain('/analytics/dashboard/zone-analytics?profession=CAREGIVER');
    });

    it('NÃO manda ?profession= quando profession é undefined', async () => {
      mockFetch({ success: true, data: ZONE_DATA });

      await ZoneAnalyticsApiService.getZoneAnalytics();

      const url = capturedUrl();
      expect(url).toContain('/analytics/dashboard/zone-analytics');
      expect(url).not.toContain('profession=');
      expect(url).not.toContain('?');
    });

    it('inclui o header Authorization quando há token', async () => {
      mockFetch({ success: true, data: ZONE_DATA });

      await ZoneAnalyticsApiService.getZoneAnalytics();

      expect(capturedOptions().headers).toMatchObject({
        Authorization: 'Bearer mock-token',
      });
    });

    it('não inclui Authorization quando não há token', async () => {
      getIdToken.mockResolvedValueOnce(null);
      mockFetch({ success: true, data: ZONE_DATA });

      await ZoneAnalyticsApiService.getZoneAnalytics();

      expect(capturedOptions().headers).not.toHaveProperty('Authorization');
    });

    it('retorna data quando success=true', async () => {
      mockFetch({ success: true, data: ZONE_DATA });

      const result = await ZoneAnalyticsApiService.getZoneAnalytics();

      expect(result).toEqual(ZONE_DATA);
    });

    it('dá throw com json.error quando success=false', async () => {
      mockFetch({ success: false, error: 'Forbidden' });

      await expect(ZoneAnalyticsApiService.getZoneAnalytics()).rejects.toThrow('Forbidden');
    });

    it('dá throw com fallback "HTTP <status>" quando success=false e sem json.error', async () => {
      mockFetch({ success: false }, 500);

      await expect(ZoneAnalyticsApiService.getZoneAnalytics()).rejects.toThrow('HTTP 500');
    });

    it('dá throw com fallback "HTTP <status>" quando success=true mas sem data', async () => {
      mockFetch({ success: true }, 200);

      await expect(ZoneAnalyticsApiService.getZoneAnalytics()).rejects.toThrow('HTTP 200');
    });
  });
});
