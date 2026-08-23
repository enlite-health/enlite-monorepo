/**
 * ShortLinkService.test.ts
 *
 * Scenarios:
 *   1. buildAndCreate — builds correct UTM URL for 'site' channel (utm_source=portal_jobs)
 *   2. buildAndCreate — builds correct UTM URL for social channel (utm_source=channel)
 *   3. buildAndCreate — includes country as utm_term when provided
 *   4. buildAndCreate — a URL é função PURA de caso/vaga/canal/país, sem dado de paciente
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
  let mockDeleteLink: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateLink = jest.fn();
    mockDeleteLink = jest.fn();
    MockedShortIoClient.mockImplementation(() => ({
      config: { apiKey: 'test-key', domain: 'test.domain' },
      createLink: mockCreateLink,
      deleteLink: mockDeleteLink,
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

    // ── Guarda de regressão: PROCEDÊNCIA, não formato ────────────────────────
    // A URL encurtada é criada no Short.io (terceiro) e publicada em rede social.
    // Até 23/08/2026 o `utm_content` recebia `patients.diagnosis` — texto livre.
    //
    // A 1ª versão desta guarda validava FORMA (`/^[A-Za-z0-9_-]{1,24}$/`) e FUROU:
    // sabotar com 'Alzheimer' passava 16/16 verde. Todo diagnóstico curto passava.
    // Agora a asserção é de igualdade EXATA do conjunto de params: qualquer chave
    // a mais — com qualquer valor — reprova, sem depender de adivinhar o formato.
    it('a URL é função PURA das entradas: nenhum param além dos derivados', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/y', id: '5' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({
        caseNumber: 7,
        vacancyNumber: 2,
        channel: 'linkedin',
        country: 'AR',
      });

      const url = new URL(result.originalURL);
      expect(url.origin + url.pathname).toBe('https://app.enlite.health/vacantes/caso7-2');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        utm_source: 'linkedin',
        utm_medium: 'vacante',
        utm_campaign: '7',
        utm_id: 'recrutamento',
        utm_term: 'AR',
      });
    });

    it('sem país, o utm_term some — e nada ocupa o lugar', async () => {
      mockCreateLink.mockResolvedValueOnce({ shortURL: 'https://srt.io/z', id: '6' });

      const svc = new ShortLinkService('key', 'srt.io');
      const result = await svc.buildAndCreate({ caseNumber: 7, vacancyNumber: 2, channel: 'site' });

      const url = new URL(result.originalURL);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        utm_source: 'portal_jobs',
        utm_medium: 'vacante',
        utm_campaign: '7',
        utm_id: 'recrutamento',
      });
    });

    it('delete(id) repassa o id ao client do Short.io', async () => {
      mockDeleteLink.mockResolvedValueOnce(undefined);

      await new ShortLinkService('key', 'srt.io').delete('lnk-123');

      expect(mockDeleteLink).toHaveBeenCalledWith('lnk-123');
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
