/**
 * ShortLinkService.test.ts
 *
 * Scenarios:
 *   1. buildAndCreate — builds correct UTM URL for 'site' channel (utm_source=portal_jobs)
 *   2. buildAndCreate — builds correct UTM URL for social channel (utm_source=channel)
 *   3. buildAndCreate — includes country as utm_term when provided
 *   4. buildAndCreate — includes pathologies as utm_content when provided
 *   5. buildAndCreate — omits optional UTM params when null
 *   6. buildAndCreate — passes domain to ShortIoClient
 *   7. buildAndCreate — returns shortURL + id + originalURL
 *   8. fromEnv — returns null when env vars missing
 *   9. fromEnv — returns instance when env vars set
 */

import { ShortLinkService } from '../ShortLinkService';
import { ShortIoClient } from '../ShortIoClient';

jest.mock('../ShortIoClient');

const MockedShortIoClient = ShortIoClient as jest.MockedClass<typeof ShortIoClient>;

describe('ShortLinkService', () => {
  let mockCreateLink: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateLink = jest.fn();
    MockedShortIoClient.mockImplementation(() => ({
      config: { apiKey: 'test-key', domain: 'test.domain' },
      createLink: mockCreateLink,
    }) as unknown as ShortIoClient);
  });

  describe('buildAndCreate', () => {
    it('uses portal_jobs as utm_source for site channel', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/abc', id: '1' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 42,
        vacancyNumber: 7,
        channel: 'site',
      });

      expect(mockCreateLink).toHaveBeenCalledTimes(1);
      const { originalURL } = result;
      const url = new URL(originalURL);
      expect(url.searchParams.get('utm_source')).toBe('portal_jobs');
      expect(url.searchParams.get('utm_medium')).toBe('vacante');
      expect(url.searchParams.get('utm_campaign')).toBe('42');
      expect(url.searchParams.get('utm_id')).toBe('recrutamento');
    });

    it('uses channel name as utm_source for social channels', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/fb', id: '2' });

      const svc = new ShortLinkService('key', 'srt.io');
      await svc.buildAndCreate({
        caseNumber: 10,
        vacancyNumber: 3,
        channel: 'facebook',
      });

      const { originalURL } = (mockCreateLink.mock.calls[0] as [{ originalURL: string }])[0];
      const url = new URL(originalURL);
      expect(url.searchParams.get('utm_source')).toBe('facebook');
    });

    it('includes utm_term when country is provided', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/x', id: '3' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 5,
        vacancyNumber: 1,
        channel: 'instagram',
        country: 'AR',
      });

      const url = new URL(result.originalURL);
      expect(url.searchParams.get('utm_term')).toBe('AR');
    });

    it('omits utm_term when country is null', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/x', id: '4' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 5,
        vacancyNumber: 1,
        channel: 'whatsapp',
        country: null,
      });

      const url = new URL(result.originalURL);
      expect(url.searchParams.has('utm_term')).toBe(false);
    });

    it('utm_content carrega o número da vaga, não dado do paciente', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/y', id: '5' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 7,
        vacancyNumber: 2,
        channel: 'linkedin',
      });

      const url = new URL(result.originalURL);
      expect(url.searchParams.get('utm_content')).toBe('2');
    });

    // Guarda de regressão: a URL encurtada é criada no Short.io (terceiro) e
    // publicada em rede social. Nada de paciente pode entrar nela. Até 23/08/2026
    // o `utm_content` recebia `patients.diagnosis` — texto livre, com cauda de
    // 522 caracteres nas vagas que estavam no ar.
    it('nenhum parâmetro da URL carrega dado clínico do paciente', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/z', id: '6' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 7,
        vacancyNumber: 2,
        channel: 'site',
        country: 'AR',
      });

      const url = new URL(result.originalURL);
      const permitidos = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content'];
      expect([...url.searchParams.keys()].sort()).toEqual([...permitidos].sort());
      // todo valor tem de ser derivável de caso/vaga/canal/país — nunca texto livre
      expect([...url.searchParams.values()].every(v => /^[A-Za-z0-9_-]{1,24}$/.test(v))).toBe(true);
    });

    it('passes correct domain to ShortIoClient.createLink', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://short.domain/k', id: '7' });

      const svc = new ShortLinkService('my-key', 'short.domain');
      await svc.buildAndCreate({ caseNumber: 1, vacancyNumber: 1, channel: 'site' });

      const callArg = mockCreateLink.mock.calls[0][0] as { domain: string };
      expect(callArg.domain).toBe('short.domain');
    });

    it('returns shortURL, id, and originalURL', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/ret', id: 'ret-id' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 3,
        vacancyNumber: 4,
        channel: 'site',
        country: 'UY',
      });

      expect(result.shortURL).toBe('https://srt.io/ret');
      expect(result.id).toBe('ret-id');
      expect(result.originalURL).toContain('caso3-4');
      expect(result.originalURL).toContain('utm_source=portal_jobs');
    });

    it('builds title with correct Caso format', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/t', id: 'tid' });

      const svc = new ShortLinkService('key', 'srt.io');
      await svc.buildAndCreate({ caseNumber: 99, vacancyNumber: 5, channel: 'facebook' });

      const callArg = mockCreateLink.mock.calls[0][0] as { title: string };
      expect(callArg.title).toBe('Caso 99-5 — facebook');
    });
  });

  describe('fromEnv', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns null when SHORT_IO_API_KEY is missing', () => {
      process.env = { ...originalEnv };
      delete process.env.SHORT_IO_API_KEY;
      delete process.env.SHORT_IO_DOMAIN;

      expect(ShortLinkService.fromEnv()).toBeNull();
    });

    it('returns null when SHORT_IO_DOMAIN is missing', () => {
      process.env = { ...originalEnv, SHORT_IO_API_KEY: 'key' };
      delete process.env.SHORT_IO_DOMAIN;

      expect(ShortLinkService.fromEnv()).toBeNull();
    });

    it('returns ShortLinkService instance when both env vars are set', () => {
      process.env = { ...originalEnv, SHORT_IO_API_KEY: 'key', SHORT_IO_DOMAIN: 'my.io' };

      const svc = ShortLinkService.fromEnv();
      expect(svc).toBeInstanceOf(ShortLinkService);
    });
  });
});
