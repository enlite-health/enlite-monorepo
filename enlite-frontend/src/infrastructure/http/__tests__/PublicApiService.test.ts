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

    it('NUNCA envia `pathology`, nem se o chamador insistir (o backend devolve 400)', async () => {
      const spy = mockFetch([]);

      // `as never` força um campo que o tipo já não aceita — é assim que se prova que a
      // proteção não depende só do TypeScript. Um chamador em JS puro faria exatamente isto.
      await PublicApiService.getPublicJobs({ country: 'AR', pathology: 'Alzheimer' } as never);

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('pathology');
      expect(calledUrl).not.toContain('Alzheimer');
    });

    it('ignora filters com valor undefined ou string vazia', async () => {
      const spy = mockFetch([]);

      await PublicApiService.getPublicJobs({
        country: 'AR',
        state: '',
        city: undefined,
      });

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('country=AR');
      expect(calledUrl).not.toContain('state=');
      expect(calledUrl).not.toContain('city=');
      // ⚠️ CONTROLE POSITIVO (25/08/2026): `pathology` saiu do tipo, mas a asserção FICA — e
      // com `as never` de propósito, para valer mesmo se alguém reintroduzir o campo. O
      // backend responde **400** a este parâmetro; mandá-lo quebra a listagem inteira, não só
      // o filtro. Régua que some junto com o campo não protege contra o campo voltar.
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
