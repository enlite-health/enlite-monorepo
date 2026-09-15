/**
 * Testes da implementação HTTP real (contrato fixo da fase 1). Só `fetch` e `FirebaseAuthService`
 * são stubados — a classe real roda. Cobre sucesso, 404, 409, 400, 503 (contrato do brief:
 * `ANACARE_SOURCE_NOT_CONFIGURED` nunca pode virar tela branca) e o filtro client-side.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn<[], Promise<string | null>>() }));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

import { AnaCareHoursHttpService } from './AnaCareHoursHttpService';
import { AnaCareHoursServiceError } from './AnaCareHoursService';
import type { AnaCareMonthSnapshot, AnaCarePatient } from './types';

let originalFetch: typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

function noContentResponse(status = 204): Response {
  return { status, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
}

const SNAPSHOT: AnaCareMonthSnapshot = {
  month: '2026-08',
  updatedAt: '2026-09-15T08:00:00-03:00',
  stale: false,
  circuitBreakerOpen: false,
  patients: [
    {
      anaCareId: '90000',
      linked: true,
      name: 'Lucía Fernández QA',
      providers: [{ anaCareId: '90200', linked: true, name: 'Rocío García QA', shifts: [] }],
    },
    { anaCareId: '90447', linked: false, providers: [] },
  ],
};

const PATIENT: AnaCarePatient = SNAPSHOT.patients[0];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockGetIdToken.mockResolvedValue('token-abc');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('getMonthSnapshot', () => {
  it('POSITIVO — GET /months/:month devolve o snapshot e manda o Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: SNAPSHOT }));
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    const result = await service.getMonthSnapshot('2026-08');
    expect(result.patients).toHaveLength(2);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer token-abc');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/admin/anacare-hours/months/2026-08');
  });

  it('POSITIVO — filtro por patientSearch roda NO CLIENTE, nunca vai na URL (PII)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: SNAPSHOT }));
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    const result = await service.getMonthSnapshot('2026-08', { patientSearch: 'Lucía' });
    expect(result.patients).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).not.toContain('Lucía');
    expect(fetchMock.mock.calls[0][0]).not.toContain('search');
  });

  it('NEGATIVO — 503 ANACARE_SOURCE_NOT_CONFIGURED vira AnaCareHoursServiceError FONTE_NAO_CONFIGURADA', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(503, { success: false, error: 'ANACARE_SOURCE_NOT_CONFIGURED', code: 'ANACARE_SOURCE_NOT_CONFIGURED' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'FONTE_NAO_CONFIGURADA' });
    await expect(service.getMonthSnapshot('2026-08')).rejects.toBeInstanceOf(AnaCareHoursServiceError);
  });

  it('NEGATIVO — 404 devolve snapshot vazio (mês sem retrato ainda), nunca lança', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    const result = await service.getMonthSnapshot('2099-01');
    expect(result.patients).toEqual([]);
  });
});

describe('getPatientMonth', () => {
  it('POSITIVO — devolve o paciente', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: PATIENT }));
    const service = new AnaCareHoursHttpService();
    const result = await service.getPatientMonth('2026-08', '90000');
    expect(result?.anaCareId).toBe('90000');
  });

  it('NEGATIVO — 404 devolve null (nunca lança)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    const result = await service.getPatientMonth('2026-08', 'no-existe');
    expect(result).toBeNull();
  });
});

describe('getRetratoStatus', () => {
  it('POSITIVO — deriva stale/circuitBreakerOpen do snapshot completo (sem endpoint dedicado no contrato)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { ...SNAPSHOT, stale: true } }));
    const service = new AnaCareHoursHttpService();
    const status = await service.getRetratoStatus('2026-08');
    expect(status.stale).toBe(true);
  });
});

describe('validateShift', () => {
  it('POSITIVO — 204 resolve sem corpo, body enviado é {}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContentResponse());
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await expect(service.validateShift({ shiftId: 'shift-1' })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/shifts/shift-1/validate');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('NEGATIVO — 409 JA_VALIDADO vira AnaCareHoursServiceError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(409, { success: false, error: 'ya validado', code: 'JA_VALIDADO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toMatchObject({ code: 'JA_VALIDADO' });
  });

  it('NEGATIVO — 409 RETRATO_DESATUALIZADO vira AnaCareHoursServiceError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(409, { success: false, error: 'stale', code: 'RETRATO_DESATUALIZADO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toMatchObject({ code: 'RETRATO_DESATUALIZADO' });
  });
});

describe('validateBatch', () => {
  it('POSITIVO — 204 resolve, body manda shiftIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContentResponse());
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await service.validateBatch({ shiftIds: ['s1', 's2'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/shifts/validate-batch');
    expect(JSON.parse(init.body)).toEqual({ shiftIds: ['s1', 's2'] });
  });
});

describe('contestShift', () => {
  it('POSITIVO — 204 resolve, body manda reason e note', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContentResponse());
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await service.contestShift({ shiftId: 'shift-1', reason: 'otro', note: 'nota' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/shifts/shift-1/contest');
    expect(JSON.parse(init.body)).toEqual({ reason: 'otro', note: 'nota' });
  });

  it('NEGATIVO — motivo inválido é recusado ANTES de sair da máquina (defesa em profundidade, 1.5b) — 0 chamadas ao fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'invalido' as never })).rejects.toMatchObject({ code: 'MOTIVO_INVALIDO' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEGATIVO — 400 do backend (nota acima do limite, por exemplo) vira AnaCareHoursServiceError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { success: false, error: 'nota muito longa', code: 'NOTA_MUITO_LONGA' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro', note: 'x' })).rejects.toMatchObject({ code: 'NOTA_MUITO_LONGA' });
  });

  it('NEGATIVO — 503 na escrita também vira FONTE_NAO_CONFIGURADA, nunca erro genérico mudo', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(503, { success: false, error: 'ANACARE_SOURCE_NOT_CONFIGURED', code: 'ANACARE_SOURCE_NOT_CONFIGURED' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro' })).rejects.toMatchObject({ code: 'FONTE_NAO_CONFIGURADA' });
  });
});
