import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicApiService, VacancyNotFoundError } from '../PublicApiService';

function mockFetch(data: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    json: () => Promise.resolve({ success: true, data }),
  } as any);
}

function mockFetchNotFound() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404 } as any);
}

describe('PublicApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getVacancy', () => {
    it('lança VacancyNotFoundError em 404', async () => {
      mockFetchNotFound();
      await expect(PublicApiService.getVacancy('id-1')).rejects.toThrow(VacancyNotFoundError);
    });
  });

  describe('getPublicJobs — TD-013', () => {
    it('chama /api/public/v1/jobs sem query string quando sem filters', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs();

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/public/v1/jobs');
      expect(calledUrl).not.toContain('?');
    });

    it('inclui country na query string quando passado', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs({ country: 'BR' });

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('country=BR');
    });

    it('inclui múltiplos filters quando passados', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs({
        country: 'AR',
        state: 'Buenos Aires',
        city: 'Palermo',
        worker_sex: 'FEMALE',
        q: 'acompanhante',
      });

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('country=AR');
      expect(calledUrl).toContain('state=Buenos+Aires');
      expect(calledUrl).toContain('city=Palermo');
      expect(calledUrl).toContain('worker_sex=FEMALE');
      expect(calledUrl).toContain('q=acompanhante');
    });

    it('ignora filters com valor undefined ou string vazia', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs({
        country: 'AR',
        state: '',
        city: undefined,
        pathology: undefined,
      });

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('country=AR');
      expect(calledUrl).not.toContain('state=');
      expect(calledUrl).not.toContain('city=');
      expect(calledUrl).not.toContain('pathology=');
    });

    it('retorna data quando success=true', async () => {
      const jobs = [{ id: 'j1', title: 'CASO 1' }];
      mockFetch(jobs);

      const result = await PublicApiService.getPublicJobs({ country: 'AR' });

      expect(result).toEqual(jobs);
    });

    it('encoda caracteres especiais corretamente', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs({ q: 'São Paulo & cuidador' });

      const calledUrl = spy.mock.calls[0][0] as string;
      // URLSearchParams encoda automaticamente
      expect(calledUrl).toMatch(/q=S%C3%A3o\+Paulo\+%26\+cuidador/);
    });
  });
});
