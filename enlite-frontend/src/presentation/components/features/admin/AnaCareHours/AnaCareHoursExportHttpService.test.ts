/**
 * Spec 032 (T2.4) — só `fetch`, `FirebaseAuthService` e o DOM de download são stubados; a classe real roda.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn<[], Promise<string | null>>() }));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

import { AnaCareHoursExportHttpService } from './AnaCareHoursExportHttpService';
import { AnaCareHoursServiceError } from './AnaCareHoursService';

const CMD = { patientId: 'AC-PAT-0', desde: '2026-09-01', hasta: '2026-09-30' };
const FILENAME = 'Sin_vinculo_ID_ACPAT0-2026-09-01-2026-09-30.xlsx';

let originalFetch: typeof globalThis.fetch;
let anchorClicks: Array<{ download: string; href: string }>;
let clickSpy: ReturnType<typeof vi.spyOn>;

function fileResponse(headers: Record<string, string> = { 'X-Export-Filename': FILENAME }): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    blob: async () => new Blob(['xlsx-bytes']),
  } as unknown as Response;
}

function errorResponse(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' && body !== undefined ? 'application/json' : null) },
    json: async () => body,
    blob: async () => new Blob(['{}']),
  } as unknown as Response;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockGetIdToken.mockResolvedValue('token-abc');
  anchorClicks = [];
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.download, href: this.href });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clickSpy.mockRestore();
  vi.clearAllMocks();
});

describe('AnaCareHoursExportHttpService.exportPatientRange', () => {
  it('POSITIVO — GET autenticado na rota certa, com desde/hasta na query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    globalThis.fetch = fetchMock;
    await new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/admin/anacare-hours/patients/AC-PAT-0/export?desde=2026-09-01&hasta=2026-09-30');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer token-abc');
  });

  it('POSITIVO — baixa o blob num <a download> com o nome do header X-Export-Filename', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fileResponse());
    await new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    expect(anchorClicks).toEqual([{ download: FILENAME, href: 'blob:fake' }]);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('POSITIVO — NÃO lê Content-Disposition (só o X-Export-Filename é exposto no CORS)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fileResponse({ 'Content-Disposition': 'attachment; filename="outro.xlsx"', 'X-Export-Filename': FILENAME }));
    await new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    expect(anchorClicks[0].download).toBe(FILENAME);
  });

  it('POSITIVO — sem o header, cai num nome determinístico (nunca vazio, nunca com PII)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fileResponse({}));
    await new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    expect(anchorClicks[0].download).toBe('horas-anacare-2026-09-01-2026-09-30.xlsx');
  });

  it('POSITIVO — o id do paciente é codificado na URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    globalThis.fetch = fetchMock;
    await new AnaCareHoursExportHttpService().exportPatientRange({ ...CMD, patientId: 'a/b c' });
    expect(fetchMock.mock.calls[0][0]).toContain('/patients/a%2Fb%20c/export');
  });

  it.each([
    [503, { success: false, error: 'FONTE_SEM_INTERVALO', code: 'FONTE_SEM_INTERVALO' }, 'FONTE_SEM_INTERVALO'],
    [503, { success: false, error: 'Ana Care source not configured', code: 'ANACARE_SOURCE_NOT_CONFIGURED' }, 'FONTE_NAO_CONFIGURADA'],
    [400, { success: false, error: 'Invalid params or query' }, 'PEDIDO_INVALIDO'],
    [403, { success: false, error: 'Forbidden' }, 'SEM_PERMISSAO'],
    [500, { success: false, error: 'Internal error' }, 'DESCONHECIDO'],
  ])('NEGATIVO — HTTP %i vira AnaCareHoursServiceError(%s) e NUNCA baixa arquivo', async (status, body, code) => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(status, body));
    const promise = new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    await expect(promise).rejects.toBeInstanceOf(AnaCareHoursServiceError);
    await expect(promise).rejects.toMatchObject({ code });
    expect(anchorClicks).toEqual([]);
  });

  it('NEGATIVO — erro sem corpo JSON (proxy 502) vira DESCONHECIDO e nunca baixa', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(502));
    await expect(new AnaCareHoursExportHttpService().exportPatientRange(CMD)).rejects.toMatchObject({ code: 'DESCONHECIDO' });
    expect(anchorClicks).toEqual([]);
  });

  it('NEGATIVO — falha de rede propaga e nunca baixa', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network down'));
    await expect(new AnaCareHoursExportHttpService().exportPatientRange(CMD)).rejects.toThrow('network down');
    expect(anchorClicks).toEqual([]);
  });

  it('POSITIVO — sem token, ainda chama (sem Authorization) — o backend decide', async () => {
    mockGetIdToken.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(fileResponse());
    globalThis.fetch = fetchMock;
    await new AnaCareHoursExportHttpService().exportPatientRange(CMD);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
