import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AdminVacancyListApiService } from '../AdminVacancyListApiService';

// Mock FirebaseAuthService so no real Firebase initialisation is required.
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

describe('AdminVacancyListApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  function stubFetch(body: unknown) {
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve(body),
    });
  }

  function capturedUrl(): string {
    return (global.fetch as Mock).mock.calls[0][0] as string;
  }

  describe('listVacancies', () => {
    it('calls /api/admin/vacancies with no params when no filters given', async () => {
      stubFetch({ success: true, data: [], total: 0 });
      await AdminVacancyListApiService.listVacancies();
      expect(capturedUrl()).toContain('/api/admin/vacancies');
    });

    it('omits empty-string values from query params', async () => {
      stubFetch({ success: true, data: [], total: 0 });
      await AdminVacancyListApiService.listVacancies({
        search: '',
        status: '',
        worker_type: 'AT',
      });
      const url = capturedUrl();
      expect(url).toContain('worker_type=AT');
      expect(url).not.toContain('search=');
      expect(url).not.toContain('status=');
    });

    it('omits undefined values from query params', async () => {
      stubFetch({ success: true, data: [], total: 0 });
      await AdminVacancyListApiService.listVacancies({
        search: undefined,
        required_sex: 'F',
      });
      const url = capturedUrl();
      expect(url).toContain('required_sex=F');
      expect(url).not.toContain('search');
    });

    it('serialises days CSV correctly', async () => {
      stubFetch({ success: true, data: [], total: 0 });
      await AdminVacancyListApiService.listVacancies({ days: '1,3,5' });
      const url = capturedUrl();
      // URLSearchParams encodes commas as %2C
      expect(url).toContain('days=1%2C3%2C5');
    });

    it('includes time_from and time_to when both provided', async () => {
      stubFetch({ success: true, data: [], total: 0 });
      await AdminVacancyListApiService.listVacancies({
        time_from: '09:00',
        time_to: '17:00',
      });
      const url = capturedUrl();
      expect(url).toContain('time_from=09%3A00');
      expect(url).toContain('time_to=17%3A00');
    });

    it('returns data and total from response', async () => {
      const mockData = [{ id: 'v-1' }, { id: 'v-2' }];
      stubFetch({ success: true, data: mockData, total: 2 });
      const result = await AdminVacancyListApiService.listVacancies();
      expect(result.data).toEqual(mockData);
      expect(result.total).toBe(2);
    });

    it('throws when success is false', async () => {
      stubFetch({ success: false, error: 'Unauthorized' });
      await expect(AdminVacancyListApiService.listVacancies()).rejects.toThrow('Unauthorized');
    });
  });

  describe('getVacancyFilterOptions', () => {
    it('calls /api/admin/vacancies/filter-options', async () => {
      stubFetch({ success: true, data: { states: ['Buenos Aires'], cities: ['Palermo'] } });
      const result = await AdminVacancyListApiService.getVacancyFilterOptions();
      expect(capturedUrl()).toContain('/api/admin/vacancies/filter-options');
      expect(result.states).toEqual(['Buenos Aires']);
      expect(result.cities).toEqual(['Palermo']);
    });

    it('throws when success is false', async () => {
      stubFetch({ success: false, error: 'Not found' });
      await expect(AdminVacancyListApiService.getVacancyFilterOptions()).rejects.toThrow('Not found');
    });
  });
});
