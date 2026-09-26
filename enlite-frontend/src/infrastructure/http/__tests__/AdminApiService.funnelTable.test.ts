import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { AdminApiService } from '../AdminApiService';

describe('AdminApiService.getVacancyFunnelTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AdminApiService, 'getAuthHeaders' as keyof typeof AdminApiService).mockResolvedValue({
      'Content-Type': 'application/json',
    });
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { rows: [], counts: {} } }),
      headers: { get: () => null },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capturedUrl(): string {
    return (global.fetch as Mock).mock.calls[0][0] as string;
  }

  it('{ bucket: "ALL" } monta ?bucket=ALL', async () => {
    await AdminApiService.getVacancyFunnelTable('vac-1', { bucket: 'ALL' });

    expect(capturedUrl()).toContain('/api/admin/vacancies/vac-1/funnel-table?bucket=ALL');
  });

  it('{ columns: [...] } monta ?columns=<ids separados por vírgula>', async () => {
    await AdminApiService.getVacancyFunnelTable('vac-1', {
      columns: ['PRE_SCREENING', 'IN_PROGRESS'],
    });

    expect(capturedUrl()).toContain(
      '/api/admin/vacancies/vac-1/funnel-table?columns=PRE_SCREENING,IN_PROGRESS',
    );
  });
});
