/**
 * AdminWorkerListApiService.test.ts
 *
 * Unit tests for worker listing, case-options and filter-options endpoints.
 * These cases were extracted from AdminApiService.workers.test.ts when
 * listWorkers/listCaseOptions/getWorkerFilterOptions were moved to the
 * dedicated AdminWorkerListApiService.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AdminWorkerListApiService } from '../AdminWorkerListApiService';

// Mock FirebaseAuthService so no real Firebase initialisation is required.
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

describe('AdminWorkerListApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  function mockFetch(data: unknown[] = [], total = 0) {
    (global.fetch as Mock).mockResolvedValue({
      json: async () => ({ success: true, data, total, limit: 20, offset: 0 }),
      headers: {
        get: (name: string) => (name === 'content-type' ? 'application/json' : null),
      },
    });
  }

  function capturedUrl(): string {
    return (global.fetch as Mock).mock.calls[0][0] as string;
  }

  // ─── listWorkers ──────────────────────────────────────────────────────────

  describe('listWorkers', () => {
    it('sem filtros chama GET /api/admin/workers', async () => {
      mockFetch();
      const result = await AdminWorkerListApiService.listWorkers();

      expect(capturedUrl()).toContain('/api/admin/workers');
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('platform=talentum é incluído na URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ platform: 'talentum' });

      expect(capturedUrl()).toContain('platform=talentum');
    });

    it('platform=ana_care é incluído na URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ platform: 'ana_care' });

      expect(capturedUrl()).toContain('platform=ana_care');
    });

    it('docs_complete=complete é incluído na URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ docs_complete: 'complete' });

      expect(capturedUrl()).toContain('docs_complete=complete');
    });

    it('docs_complete=incomplete é incluído na URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ docs_complete: 'incomplete' });

      expect(capturedUrl()).toContain('docs_complete=incomplete');
    });

    it('limit e offset são incluídos na URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ limit: '10', offset: '20' });

      const url = capturedUrl();
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=20');
    });

    it('retorna data e total corretamente do JSON de resposta', async () => {
      const workers = [
        { id: 'w1', name: 'João', casesCount: 1, documentsComplete: true, platform: 'talentum' },
      ];
      mockFetch(workers, 42);

      const result = await AdminWorkerListApiService.listWorkers();

      expect(result.data).toEqual(workers);
      expect(result.total).toBe(42);
    });

    it('lança erro quando API retorna success=false', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({ success: false, error: 'Unauthorized' }),
        status: 401,
        headers: {
          get: (name: string) => (name === 'content-type' ? 'application/json' : null),
        },
      });

      await expect(AdminWorkerListApiService.listWorkers()).rejects.toThrow('Unauthorized');
    });

    it('filtros combinados são todos incluídos na URL', async () => {
      mockFetch([{ id: 'w1' }], 1);
      await AdminWorkerListApiService.listWorkers({
        platform: 'planilla_operativa',
        docs_complete: 'incomplete',
        limit: '5',
        offset: '10',
      });

      const url = capturedUrl();
      expect(url).toContain('platform=planilla_operativa');
      expect(url).toContain('docs_complete=incomplete');
      expect(url).toContain('limit=5');
      expect(url).toContain('offset=10');
    });

    // Profile-filter params (new filters added in the refactor)
    it('profession é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ profession: 'AT' });
      expect(capturedUrl()).toContain('profession=AT');
    });

    it('preferred_age_range é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ preferred_age_range: '18-30' });
      expect(capturedUrl()).toContain('preferred_age_range=18-30');
    });

    it('experience_type é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ experience_type: 'TEA' });
      expect(capturedUrl()).toContain('experience_type=TEA');
    });

    it('preferred_type é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ preferred_type: 'adulto' });
      expect(capturedUrl()).toContain('preferred_type=adulto');
    });

    it('language é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ language: 'es' });
      expect(capturedUrl()).toContain('language=es');
    });

    it('sex é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ sex: 'F' });
      expect(capturedUrl()).toContain('sex=F');
    });

    it('state é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ state: 'Buenos Aires' });
      expect(capturedUrl()).toContain('state=Buenos+Aires');
    });

    it('city é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ city: 'Palermo' });
      expect(capturedUrl()).toContain('city=Palermo');
    });

    it('days CSV é incluído na URL quando fornecido', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({ days: '1,3,5' });
      // URLSearchParams encodes commas as %2C
      expect(capturedUrl()).toContain('days=1%2C3%2C5');
    });

    it('valores vazios e undefined são omitidos da URL', async () => {
      mockFetch();
      await AdminWorkerListApiService.listWorkers({
        platform: '',
        profession: undefined,
        limit: '20',
      });
      const url = capturedUrl();
      expect(url).toContain('limit=20');
      expect(url).not.toContain('platform=');
      expect(url).not.toContain('profession=');
    });
  });

  // ─── listCaseOptions ──────────────────────────────────────────────────────

  describe('listCaseOptions', () => {
    it('chama GET /api/admin/workers/case-options', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({ success: true, data: [] }),
        headers: { get: () => null },
      });

      const result = await AdminWorkerListApiService.listCaseOptions();

      expect(capturedUrl()).toContain('/api/admin/workers/case-options');
      expect(result).toEqual([]);
    });

    it('retorna lista de opções de caso corretamente', async () => {
      const options = [
        { value: 'case-1', label: 'Caso #100' },
        { value: 'case-2', label: 'Caso #101' },
      ];
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({ success: true, data: options }),
        headers: { get: () => null },
      });

      const result = await AdminWorkerListApiService.listCaseOptions();

      expect(result).toEqual(options);
    });

    it('lança erro quando API retorna success=false', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({ success: false, error: 'Forbidden' }),
        headers: { get: () => null },
      });

      await expect(AdminWorkerListApiService.listCaseOptions()).rejects.toThrow('Forbidden');
    });
  });

  // ─── getWorkerFilterOptions ───────────────────────────────────────────────

  describe('getWorkerFilterOptions', () => {
    it('chama GET /api/admin/workers/filter-options', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({
          success: true,
          data: { states: ['Buenos Aires'], cities: ['Palermo'], experienceTypes: [], preferredTypes: [] },
        }),
        headers: { get: () => null },
      });

      const result = await AdminWorkerListApiService.getWorkerFilterOptions();

      expect(capturedUrl()).toContain('/api/admin/workers/filter-options');
      expect(result.states).toEqual(['Buenos Aires']);
      expect(result.cities).toEqual(['Palermo']);
    });

    it('retorna arrays vazios quando dados ausentes', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({
          success: true,
          data: { states: [], cities: [], experienceTypes: [], preferredTypes: [] },
        }),
        headers: { get: () => null },
      });

      const result = await AdminWorkerListApiService.getWorkerFilterOptions();

      expect(result.states).toEqual([]);
      expect(result.cities).toEqual([]);
      expect(result.experienceTypes).toEqual([]);
      expect(result.preferredTypes).toEqual([]);
    });

    it('lança erro quando API retorna success=false', async () => {
      (global.fetch as Mock).mockResolvedValue({
        json: async () => ({ success: false, error: 'Not found' }),
        headers: { get: () => null },
      });

      await expect(AdminWorkerListApiService.getWorkerFilterOptions()).rejects.toThrow('Not found');
    });
  });
});
