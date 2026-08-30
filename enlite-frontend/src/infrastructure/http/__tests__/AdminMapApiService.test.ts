import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminMapApiService } from '../AdminMapApiService';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn() }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response;
}

const CABA = { lat: -34.6037, lng: -58.3816 };

describe('AdminMapApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('tok-1');
  });

  it('getWorkersMap: POST com corpo JSON (coordenada nunca na URL) e Bearer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: [{ id: 'w1' }], total: 1, withoutCoordinates: 0, truncated: false }));
    const res = await AdminMapApiService.getWorkersMap({ country: 'AR', center: CABA, radius_km: 5, docs_complete: 'incomplete' });
    expect(res).toEqual({ data: [{ id: 'w1' }], total: 1, withoutCoordinates: 0, truncated: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/api/admin/workers/map');
    expect(url).not.toMatch(/34\.6|58\.3/);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' });
    expect(JSON.parse(init.body as string)).toEqual({ country: 'AR', center: CABA, radius_km: 5, docs_complete: 'incomplete' });
  });

  it('getPatientsMap: caminho de pacientes; sem token não manda Authorization; defaults quando o corpo vem magro', async () => {
    mockGetIdToken.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));
    const res = await AdminMapApiService.getPatientsMap({ country: 'AR', state: 'Buenos Aires' });
    expect(res).toEqual({ data: [], total: 0, withoutCoordinates: 0, truncated: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/api/admin/patients/map');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('erro do backend (success=false) vira exceção com a mensagem; sem mensagem vira HTTP <status>', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ success: false, error: 'Invalid map filters' }, 400));
    await expect(AdminMapApiService.getWorkersMap({ country: 'AR', city: 'x' })).rejects.toThrow('Invalid map filters');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ success: false }, 500));
    await expect(AdminMapApiService.getWorkersMap({ country: 'AR', city: 'x' })).rejects.toThrow('HTTP 500');
  });

  it('resposta não-JSON (proxy caído) vira erro de conexão', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse('<html/>', 502, 'text/html'));
    await expect(AdminMapApiService.getPatientsMap({ country: 'AR', city: 'x' })).rejects.toThrow('Erro ao conectar ao servidor (HTTP 502)');
  });

  it('resposta sem content-type conta como não-JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ status: 204, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    await expect(AdminMapApiService.getPatientsMap({ country: 'AR', city: 'x' })).rejects.toThrow('HTTP 204');
  });
});
