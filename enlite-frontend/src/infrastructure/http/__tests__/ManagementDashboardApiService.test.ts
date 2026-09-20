/**
 * ManagementDashboardApiService.test.ts (PR-9, `lex` #9)
 *
 * Cobre a query string (`funnelPeriodDays`/`country`) e o mapeamento de erro
 * (403 COUNTRY_SCOPE_REQUIRED / 400 INVALID_COUNTRY preferem `detail` sobre
 * `error`; sem nenhum dos dois cai no HTTP status).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagementDashboardApiService } from '../ManagementDashboardApiService';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn() }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

function mockFetchOnce(status: number, json: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: async () => json,
  }) as unknown as typeof fetch;
}

describe('ManagementDashboardApiService.getManagementDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('tok-123');
  });

  it('sem argumentos: URL sem query string nenhuma', async () => {
    mockFetchOnce(200, { success: true, data: { scope: { countries: ['AR'], requested: 'ALL' } } });
    await ManagementDashboardApiService.getManagementDashboard();

    const [url] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).not.toContain('?');
  });

  it('só funnelPeriodDays: `?funnelPeriodDays=30`, sem `country`', async () => {
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard(30);

    const [url] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('funnelPeriodDays=30');
    expect(url).not.toContain('country=');
  });

  it('só country: `?country=BR`, sem `funnelPeriodDays` (PR-9)', async () => {
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard(null, 'BR');

    const [url] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('country=BR');
    expect(url).not.toContain('funnelPeriodDays');
  });

  it('os dois juntos: `?funnelPeriodDays=7&country=AR`', async () => {
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard(7, 'AR');

    const [url] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('funnelPeriodDays=7');
    expect(url).toContain('country=AR');
  });

  it('country=null é omitido (não vira `country=null` na URL)', async () => {
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard(null, null);

    const [url] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).not.toContain('country');
  });

  it('token presente → header Authorization; ausente → sem o header', async () => {
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard();
    let [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-123' });

    mockGetIdToken.mockResolvedValue(null);
    mockFetchOnce(200, { success: true, data: {} });
    await ManagementDashboardApiService.getManagementDashboard();
    [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
  });

  it('sucesso: devolve `data`', async () => {
    const data = { scope: { countries: ['AR'], requested: 'ALL' } };
    mockFetchOnce(200, { success: true, data });
    await expect(ManagementDashboardApiService.getManagementDashboard()).resolves.toEqual(data);
  });

  it('403 COUNTRY_SCOPE_REQUIRED: usa `detail` (a mensagem legível), não `error` (o código)', async () => {
    mockFetchOnce(403, {
      success: false,
      error: 'COUNTRY_SCOPE_REQUIRED',
      detail: 'Fora do escopo do ator: BR.',
    });
    await expect(ManagementDashboardApiService.getManagementDashboard(null, 'BR')).rejects.toThrow(
      'Fora do escopo do ator: BR.',
    );
  });

  it('400 INVALID_COUNTRY: idem, prefere `detail`', async () => {
    mockFetchOnce(400, {
      success: false,
      error: 'INVALID_COUNTRY',
      detail: 'country deve ser AR, BR ou ALL.',
    });
    await expect(ManagementDashboardApiService.getManagementDashboard(null, 'US' as never)).rejects.toThrow(
      'country deve ser AR, BR ou ALL.',
    );
  });

  it('erro sem `detail` (só `error`): usa `error`', async () => {
    mockFetchOnce(500, { success: false, error: 'boom' });
    await expect(ManagementDashboardApiService.getManagementDashboard()).rejects.toThrow('boom');
  });

  it('erro sem `detail` NEM `error`: cai no HTTP status', async () => {
    mockFetchOnce(500, { success: false });
    await expect(ManagementDashboardApiService.getManagementDashboard()).rejects.toThrow('HTTP 500');
  });

  it('success=true mas sem `data`: também é tratado como erro', async () => {
    mockFetchOnce(200, { success: true });
    await expect(ManagementDashboardApiService.getManagementDashboard()).rejects.toThrow('HTTP 200');
  });
});
