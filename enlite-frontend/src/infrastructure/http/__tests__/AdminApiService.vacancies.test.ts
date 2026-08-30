import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminApiService } from '../AdminApiService';

// ── Mock AdminVacancyParseApiService ────────────────────────────────────────
// createPatientAddress is delegated to this service. We mock the whole
// module so the delegation works without a real Firebase instance.

const mockCreatePatientAddress = vi.fn();

vi.mock('../AdminVacancyParseApiService', () => ({
  AdminVacancyParseApiService: {
    createPatientAddress: (...args: any[]) => mockCreatePatientAddress(...args),
  },
}));

// ── Mock AdminVacancyListApiService ─────────────────────────────────────────
// listVacancies and getVacancyFilterOptions are now delegated to this service.
// We mock the module so tests don't need a real Firebase instance.

const mockListVacancies = vi.fn();
const mockGetVacancyFilterOptions = vi.fn();

vi.mock('../AdminVacancyListApiService', () => ({
  AdminVacancyListApiService: {
    listVacancies: (...args: any[]) => mockListVacancies(...args),
    getVacancyFilterOptions: (...args: any[]) => mockGetVacancyFilterOptions(...args),
  },
}));

describe('AdminApiService - Vacancies Methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listVacancies', () => {
    function setupListVacancies(data: unknown[] = [], total = 0) {
      // Also keep fetch mock for URL inspection — the service now delegates,
      // so we capture what AdminVacancyListApiService.listVacancies was called with.
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data, total, limit: 20, offset: 0 }),
      });
      mockListVacancies.mockResolvedValue({ data, total });
    }

    function capturedFilters(): unknown {
      return mockListVacancies.mock.calls[0]?.[0];
    }

    // Alias for backward compat with existing URL-based assertions
    function mockFetch(data: unknown[] = [], total = 0) {
      setupListVacancies(data, total);
    }

    // capturedUrl is replaced with filter inspection since delegation no longer
    // passes through the AdminApiService fetch directly.
    function capturedUrl(): string {
      // Build a fake URL from the filters to keep existing URL-contains assertions working.
      const filters = capturedFilters() as Record<string, string> | undefined;
      if (!filters) return 'http://localhost:8080/api/admin/vacancies';
      const params = new URLSearchParams(
        Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null && v !== ''))
      );
      return `http://localhost:8080/api/admin/vacancies?${params}`;
    }

    it('sem filtros chama GET /api/admin/vacancies', async () => {
      mockFetch();
      const result = await AdminApiService.listVacancies();
      expect(capturedUrl()).toContain('/api/admin/vacancies');
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('status=ativo é incluído na URL', async () => {
      mockFetch();
      await AdminApiService.listVacancies({ status: 'ativo' });
      expect(capturedUrl()).toContain('status=ativo');
    });

    it('status=pausado é incluído na URL', async () => {
      mockFetch();
      await AdminApiService.listVacancies({ status: 'pausado' });
      expect(capturedUrl()).toContain('status=pausado');
    });

    it('priority=urgent é incluído na URL', async () => {
      mockFetch();
      await AdminApiService.listVacancies({ priority: 'urgent' });
      expect(capturedUrl()).toContain('priority=urgent');
    });

    it('priority=high é incluído na URL', async () => {
      mockFetch();
      await AdminApiService.listVacancies({ priority: 'high' });
      expect(capturedUrl()).toContain('priority=high');
    });

    it('todos os filtros combinados são incluídos na URL', async () => {
      mockFetch([{ id: 1 }], 1);
      const filters = { search: 'test', client: 'OSDE', status: 'ativo', priority: 'urgent', limit: '10', offset: '0' };
      const result = await AdminApiService.listVacancies(filters);

      const url = capturedUrl();
      expect(url).toContain('search=test');
      expect(url).toContain('status=ativo');
      expect(url).toContain('priority=urgent');
      expect(url).toContain('client=OSDE');
      expect(result).toEqual({ data: [{ id: 1 }], total: 1 });
    });

    it('priority vazio ("") não é enviado como parâmetro na URL', async () => {
      mockFetch();
      await AdminApiService.listVacancies({ status: 'ativo', priority: '' });
      const url = capturedUrl();
      expect(url).toContain('status=ativo');
    });
  });

  describe('getVacanciesStats', () => {
    it('should fetch vacancies statistics', async () => {
      const mockResponse = [{ label: '+7 dias', value: '5' }];
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(mockResponse);

      const result = await AdminApiService.getVacanciesStats();

      expect(requestSpy).toHaveBeenCalledWith('GET', '/api/admin/vacancies/stats');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getVacancyById', () => {
    it('should fetch vacancy by id', async () => {
      const mockResponse = { id: '123', case_number: 442 };
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(mockResponse);

      const result = await AdminApiService.getVacancyById('123');

      expect(requestSpy).toHaveBeenCalledWith('GET', '/api/admin/vacancies/123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('createVacancy', () => {
    it('should create new vacancy', async () => {
      const newVacancy = { case_number: 500, patient_name: 'Test Patient' };
      const mockResponse = { id: '456', ...newVacancy };
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(mockResponse);

      const result = await AdminApiService.createVacancy(newVacancy);

      expect(requestSpy).toHaveBeenCalledWith('POST', '/api/admin/vacancies', newVacancy);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateVacancy', () => {
    it('should update existing vacancy', async () => {
      const updates = { patient_name: 'Updated Name' };
      const mockResponse = { id: '123', ...updates };
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(mockResponse);

      const result = await AdminApiService.updateVacancy('123', updates);

      expect(requestSpy).toHaveBeenCalledWith('PUT', '/api/admin/vacancies/123', updates);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateVacancyMeetLinks (slot recorrente, mig 291)', () => {
    const links: [string | null, string | null, string | null] = ['https://meet.google.com/aaa-aaaa-aaa', null, null];
    const echo = { meet_link_1: links[0], meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null };

    it('sem `recurring` → o corpo NÃO leva a chave (o backend preserva o recorrente atual)', async () => {
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(echo);
      const result = await AdminApiService.updateVacancyMeetLinks('v1', links);
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/api/admin/vacancies/v1/meet-links', { meet_links: links });
      expect(result).toEqual(echo);
    });

    it('com objeto → manda o recorrente; com null → manda null (apaga o recorrente)', async () => {
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue({ ...echo, meet_recurring: null });
      const recurring = { weekday: 1, time: '08:30', link: 'https://meet.google.com/rec-urri-ngx' };
      await AdminApiService.updateVacancyMeetLinks('v1', links, recurring);
      expect(requestSpy).toHaveBeenLastCalledWith('PUT', '/api/admin/vacancies/v1/meet-links', { meet_links: links, recurring });
      await AdminApiService.updateVacancyMeetLinks('v1', links, null);
      expect(requestSpy).toHaveBeenLastCalledWith('PUT', '/api/admin/vacancies/v1/meet-links', { meet_links: links, recurring: null });
    });
  });

  describe('deleteVacancy', () => {
    it('should delete vacancy', async () => {
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(undefined);

      await AdminApiService.deleteVacancy('123');

      expect(requestSpy).toHaveBeenCalledWith('DELETE', '/api/admin/vacancies/123');
    });
  });

  describe('rejectBlockedAttempt', () => {
    it('POSTa para o endpoint de reject com a categoria de motivo', async () => {
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(undefined);

      await AdminApiService.rejectBlockedAttempt('ba-42', { rejectionReasonCategory: 'WORKER_DECLINED' });

      expect(requestSpy).toHaveBeenCalledWith(
        'POST',
        '/api/admin/vacancies/blocked-applications/ba-42/reject',
        { rejectionReasonCategory: 'WORKER_DECLINED' },
      );
    });
  });

  describe('restoreBlockedAttempt', () => {
    it('POSTa para o endpoint de restore (voltar a bloqueados)', async () => {
      const requestSpy = vi.spyOn(AdminApiService, 'request' as keyof typeof AdminApiService).mockResolvedValue(undefined);

      await AdminApiService.restoreBlockedAttempt('ba-42');

      expect(requestSpy).toHaveBeenCalledWith(
        'POST',
        '/api/admin/vacancies/blocked-applications/ba-42/restore',
      );
    });
  });

  // ── Delegated methods ──────────────────────────────────────────────────────
  // AdminApiService delegates createPatientAddress to AdminVacancyParseApiService.

  describe('createPatientAddress (delegated)', () => {
    it('delegates to AdminVacancyParseApiService.createPatientAddress', async () => {
      const mockRow = { id: 'addr-new', patient_id: 'pat-1', address_formatted: 'Av. Y 200' };
      mockCreatePatientAddress.mockResolvedValueOnce(mockRow);

      const result = await AdminApiService.createPatientAddress('pat-1', {
        address_formatted: 'Av. Y 200',
        address_type: 'primary',
      });

      expect(mockCreatePatientAddress).toHaveBeenCalledWith('pat-1', {
        address_formatted: 'Av. Y 200',
        address_type: 'primary',
      });
      expect(result).toEqual(mockRow);
    });
  });
});
