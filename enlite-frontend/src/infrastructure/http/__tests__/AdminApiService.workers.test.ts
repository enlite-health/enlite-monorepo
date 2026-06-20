import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { AdminApiService } from '../AdminApiService';

// listWorkers/listCaseOptions/getWorkerFilterOptions are delegated to
// AdminWorkerListApiService; mock it so tests don't hit Firebase initialisation.
// The actual URL-building and param logic is covered by AdminWorkerListApiService.test.ts.
vi.mock('@infrastructure/http/AdminWorkerListApiService', () => ({
  AdminWorkerListApiService: {
    listWorkers: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    listCaseOptions: vi.fn().mockResolvedValue([]),
    getWorkerFilterOptions: vi.fn().mockResolvedValue({
      states: [],
      cities: [],
      experienceTypes: [],
      preferredTypes: [],
    }),
  },
}));

describe('AdminApiService - Workers Methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AdminApiService, 'getAuthHeaders' as keyof typeof AdminApiService).mockResolvedValue({
      'Content-Type': 'application/json',
    });
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capturedUrl(): string {
    return (global.fetch as Mock).mock.calls[0][0] as string;
  }

  // listWorkers tests are now in AdminWorkerListApiService.test.ts which covers
  // the full URL-building contract (params, error handling, data mapping).
  // Here we only verify that AdminApiService correctly delegates to that service.
  describe('listWorkers — delegação para AdminWorkerListApiService', () => {
    it('sem filtros delega e retorna { data: [], total: 0 }', async () => {
      const result = await AdminApiService.listWorkers();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('passa filtros ao serviço delegado', async () => {
      const { AdminWorkerListApiService } = await import('../AdminWorkerListApiService');
      await AdminApiService.listWorkers({ platform: 'talentum', limit: '10' });
      expect(AdminWorkerListApiService.listWorkers).toHaveBeenCalledWith({
        platform: 'talentum',
        limit: '10',
      });
    });
  });

  describe('getWorkerById', () => {
    it('chama GET /api/admin/workers/:id com o ID correto', async () => {
      const workerData = { id: 'w-123', email: 'ana@test.com', firstName: 'Ana' };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data: workerData }),
        headers: { get: () => null },
      });

      const result = await AdminApiService.getWorkerById('w-123');

      expect(capturedUrl()).toContain('/api/admin/workers/w-123');
      expect(result).toEqual(workerData);
    });

    it('retorna todos os campos do WorkerDetail corretamente', async () => {
      const workerDetail = {
        id: 'w-456',
        email: 'maria@test.com',
        phone: '+55 11 99999-0000',
        whatsappPhone: '+55 11 88888-0000',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        status: 'REGISTERED',
        overallStatus: 'QUALIFIED',
        availabilityStatus: 'available',
        dataSources: ['talentum'],
        platform: 'talentum',
        firstName: 'Maria',
        lastName: 'Santos',
        isMatchable: true,
        isActive: true,
        documents: null,
        serviceAreas: [],
        location: null,
        encuadres: [],
      };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data: workerDetail }),
        headers: { get: () => null },
      });

      const result = await AdminApiService.getWorkerById('w-456');

      expect(result.id).toBe('w-456');
      expect(result.overallStatus).toBe('QUALIFIED');
      expect(result.availabilityStatus).toBe('available');
      expect(result.isMatchable).toBe(true);
    });

    it('lança erro quando API retorna success=false', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: false, error: 'Worker not found' }),
        headers: { get: () => null },
      });

      await expect(AdminApiService.getWorkerById('nonexistent')).rejects.toThrow('Worker not found');
    });

    it('lança erro genérico quando API falha sem mensagem de erro', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: false }),
        status: 500,
        headers: { get: () => null },
      });

      await expect(AdminApiService.getWorkerById('w-123')).rejects.toThrow();
    });

    it('envia método GET e headers de autenticação', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data: { id: 'w-1' } }),
        headers: { get: () => null },
      });

      await AdminApiService.getWorkerById('w-1');

      const fetchCall = (global.fetch as Mock).mock.calls[0];
      expect(fetchCall[1].method).toBe('GET');
      expect(fetchCall[1].headers).toHaveProperty('Content-Type', 'application/json');
    });
  });

  describe('getWorkerDateStats', () => {
    it('chama GET /api/admin/workers/stats', async () => {
      const statsData = { today: 5, yesterday: 3, sevenDaysAgo: 8 };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data: statsData }),
        headers: { get: () => null },
      });

      const result = await AdminApiService.getWorkerDateStats();

      expect(capturedUrl()).toContain('/api/admin/workers/stats');
      expect(result).toEqual(statsData);
    });

    it('retorna { today, yesterday, sevenDaysAgo } corretamente', async () => {
      const statsData = { today: 10, yesterday: 7, sevenDaysAgo: 25 };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: true, data: statsData }),
        headers: { get: () => null },
      });

      const result = await AdminApiService.getWorkerDateStats();

      expect(result.today).toBe(10);
      expect(result.yesterday).toBe(7);
      expect(result.sevenDaysAgo).toBe(25);
    });

    it('lança erro quando API retorna success=false', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({ success: false, error: 'Forbidden' }),
        headers: { get: () => null },
      });

      await expect(AdminApiService.getWorkerDateStats()).rejects.toThrow('Forbidden');
    });
  });
});
