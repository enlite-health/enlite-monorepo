/**
 * Testes da implementação HTTP real do envio ao Axonico — MESMO padrão de
 * `AnaCareHoursHttpService.test.ts` (só `fetch`/`FirebaseAuthService` stubados, a classe roda de
 * verdade). ⚠️ A ROTA AINDA NÃO EXISTE commitada (outra sessão está escrevendo) — este arquivo
 * testa o CLIENTE contra o contrato fixo do brief, nunca contra backend real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn<[], Promise<string | null>>() }));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

import { AxonicoComprobanteHttpService } from './AxonicoComprobanteHttpService';
import { AxonicoComprobanteServiceError } from './AxonicoComprobanteService';

let originalFetch: typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

function nonJsonResponse(status: number): Response {
  return { status, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockGetIdToken.mockResolvedValue('token-abc');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('AxonicoComprobanteHttpService', () => {
  it('POSITIVO — enviarComprobante manda o corpo EXATO do contrato (documentType presente)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' } }),
    );
    globalThis.fetch = fetchMock;
    const service = new AxonicoComprobanteHttpService();

    await service.enviarComprobante({ documentNumber: '30111222', documentType: 'DNI', serviceDate: '2026-08-14', hours: 8 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/admin/integrations/axonico/comprobante');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      documentNumber: '30111222',
      documentType: 'DNI',
      serviceType: 'AT',
      serviceDate: '2026-08-14',
      hours: 8,
    });
    // PII nunca em URL/query string.
    expect(url).not.toContain('30111222');
  });

  it('POSITIVO — sem documentType, o campo simplesmente não vai no corpo (nunca `undefined` serializado)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' } }),
    );
    globalThis.fetch = fetchMock;
    const service = new AxonicoComprobanteHttpService();

    await service.enviarComprobante({ documentNumber: '30111222', serviceDate: '2026-08-14', hours: 8 });

    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect('documentType' in parsed).toBe(false);
  });

  it('POSITIVO — resposta "enviado" devolve numeroComprobante/codAutorizacion', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'enviado', numeroComprobante: 'C-9', codAutorizacion: 'A-9' } }));
    const service = new AxonicoComprobanteHttpService();

    const result = await service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 });

    expect(result).toEqual({ status: 'enviado', numeroComprobante: 'C-9', codAutorizacion: 'A-9' });
  });

  it('POSITIVO — resposta "duplicado" carrega o comprovante ORIGINAL e jaFaturado/lancadoEm', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { status: 'duplicado', numeroComprobante: 'C-ORIGINAL', codAutorizacion: 'A-ORIGINAL', jaFaturado: true, lancadoEm: '2026-08-14T10:00:00Z' },
      }),
    );
    const service = new AxonicoComprobanteHttpService();

    const result = await service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 });

    expect(result.status).toBe('duplicado');
    expect(result.numeroComprobante).toBe('C-ORIGINAL');
    expect(result.jaFaturado).toBe(true);
  });

  it('NEGATIVO — erro 409 com corpo `{success:false}` lança AxonicoComprobanteServiceError com code/message do backend', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(409, { success: false, error: 'ConflictoDeFaturamento', message: 'Ya fue facturado con otro monto.' }));
    const service = new AxonicoComprobanteHttpService();

    await expect(service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 })).rejects.toMatchObject({
      code: 'ConflictoDeFaturamento',
      message: 'Ya fue facturado con otro monto.',
    });
  });

  it('NEGATIVO — erro sem `error` (nome ausente no corpo) cai no fallback `DESCONHECIDO`', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { success: false, message: 'Solicitud inválida.' }));
    const service = new AxonicoComprobanteHttpService();

    await expect(service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 })).rejects.toMatchObject({
      code: 'DESCONHECIDO',
      message: 'Solicitud inválida.',
    });
  });

  it('NEGATIVO — erro sem `message` cai no fallback `HTTP <status>`', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(422, { success: false, error: 'DatosInvalidos', message: '' }));
    const service = new AxonicoComprobanteHttpService();

    await expect(service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 })).rejects.toMatchObject({
      code: 'DatosInvalidos',
      message: 'HTTP 422',
    });
  });

  it('NEGATIVO — resposta sem `content-type: application/json` (ex. 502 de proxy) vira erro DESCONHECIDO, nunca tela branca', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(nonJsonResponse(502));
    const service = new AxonicoComprobanteHttpService();

    await expect(service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 })).rejects.toBeInstanceOf(AxonicoComprobanteServiceError);
  });

  it('POSITIVO — sem token de auth, o header Authorization simplesmente não vai (nunca "Bearer undefined")', async () => {
    mockGetIdToken.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' } }));
    globalThis.fetch = fetchMock;
    const service = new AxonicoComprobanteHttpService();

    await service.enviarComprobante({ documentNumber: '1', serviceDate: '2026-08-14', hours: 8 });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
