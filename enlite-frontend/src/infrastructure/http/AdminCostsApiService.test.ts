import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn<[], Promise<string | null>>() }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

import { AdminCostsApiService, CostsApiError, type CostOverview } from './AdminCostsApiService';

const OVERVIEW: CostOverview = {
  month: '2026-11', currency: 'USD', dataUntil: '2026-11-02T10:00:00Z', monthTotal: 120.5,
  prevMonthToDate: 100, prevMonthTotal: 900, forecast: { value: 1800, basis: 'linear', daysCounted: 2 },
  months: [{ month: '2026-11', total: 120.5 }], byService: [], byResource: [], bySector: [], byAiCaller: [],
  byProject: [{ project: 'enlite-prd', total: 120.5 }], availableMonths: ['2026-11', '2026-10'],
  anomalies: { status: 'insufficient_history', day: null, rule: { factor: 2, minDelta: 5, windowDays: 7 }, items: [] },
};

let originalFetch: typeof globalThis.fetch;
const mockFetch = (status: number, body: unknown) => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
};

describe('AdminCostsApiService.getOverview', () => {
  beforeEach(() => { originalFetch = globalThis.fetch; mockGetIdToken.mockResolvedValue('tok'); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('GET com o mês, Authorization e desembrulha `data`', async () => {
    mockFetch(200, { success: true, data: OVERVIEW });
    const out = await AdminCostsApiService.getOverview('2026-11');
    expect(out).toEqual(OVERVIEW);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/api/admin/costs/overview?month=2026-11');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('sem mês: sem query string; sem token: sem Authorization', async () => {
    mockGetIdToken.mockResolvedValue(null);
    mockFetch(200, { success: true, data: OVERVIEW });
    await AdminCostsApiService.getOverview();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url).endsWith('/api/admin/costs/overview')).toBe(true);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('429 sync_rate_limited: erro com status, code e retryAfterSeconds', async () => {
    mockFetch(429, { success: false, code: 'sync_rate_limited', retryAfterSeconds: 7 });
    const err = await AdminCostsApiService.getOverview().catch((e) => e);
    expect(err).toBeInstanceOf(CostsApiError);
    expect(err).toMatchObject({ status: 429, code: 'sync_rate_limited', retryAfterSeconds: 7 });
  });

  it('502 bytes_limit e billing_query_failed: mantém o code', async () => {
    mockFetch(502, { success: false, code: 'bytes_limit' });
    expect(await AdminCostsApiService.getOverview().catch((e) => e)).toMatchObject({ status: 502, code: 'bytes_limit' });
    mockFetch(502, { success: false, code: 'billing_query_failed' });
    expect(await AdminCostsApiService.getOverview().catch((e) => e)).toMatchObject({ status: 502, code: 'billing_query_failed' });
  });

  it('403 e corpo ilegível: erro com o status, sem code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => { throw new Error('x'); } });
    expect(await AdminCostsApiService.getOverview().catch((e) => e)).toMatchObject({ status: 403, code: undefined });
  });
});
