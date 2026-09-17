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

/**
 * F6.3: a rota da LISTA (`AnaCareMonthSnapshot.patients`) parou de mandar turnos — vira
 * `AnaCareListPatient` (agregado). `PATIENT`, abaixo, é o DETALHE (`AnaCarePatient`, com turnos),
 * usado só pelos testes de `getPatientMonth` — os dois tipos são DIFERENTES agora, não mais o
 * mesmo objeto reaproveitado (era o caso antes desta fase).
 */

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
  snapshotState: 'fresco',
  circuitBreakerOpen: false,
  patients: [
    {
      anaCareId: '90000',
      linked: false,
      name: 'Lucía Fernández QA',
      providers: [{ anaCareId: '90200', linked: true, name: 'Rocío García QA' }],
      providersCount: 1,
      shiftsCount: 1,
      hoursActualSum: 8,
      hoursScheduledSumMissingActual: 0,
      validated: 0,
      contested: 0,
      originSinCheckin: 0,
      originWebAdmin: 0,
      originApp: 1,
    },
    {
      anaCareId: '90447',
      linked: false,
      providers: [],
      providersCount: 0,
      shiftsCount: 0,
      hoursActualSum: 0,
      hoursScheduledSumMissingActual: 0,
      validated: 0,
      contested: 0,
      originSinCheckin: 0,
      originWebAdmin: 0,
      originApp: 0,
    },
  ],
};

/** DETALHE (`getPatientMonth`) — tipo diferente do agregado da lista (`SNAPSHOT.patients`), com turnos. */
const PATIENT: AnaCarePatient = {
  anaCareId: '90000',
  linked: true,
  name: 'Lucía Fernández QA',
  providers: [{ anaCareId: '90200', linked: true, name: 'Rocío García QA', shifts: [] }],
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockGetIdToken.mockResolvedValue('token-abc');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('getAuthHeaders', () => {
  it('NEGATIVO — sem token (usuário deslogado/expirado), a requisição sai SEM o header Authorization', async () => {
    mockGetIdToken.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: SNAPSHOT }));
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await service.getMonthSnapshot('2026-08');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
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

  // D5 (cobertura, 15/09): `headers.get('content-type')` devolvendo `null` de VERDADE (não só a
  // string vazia que os outros mocks simulam) — cobre o `?? ''` antes de checar `.includes`.
  it('NEGATIVO — content-type ausente (header.get devolve null) é tratado como corpo não-JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'DESCONHECIDO' });
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

  it('NEGATIVO — resposta 200 sem content-type JSON (ex.: proxy/HTML de erro) vira AnaCareHoursServiceError, nunca `.json()` quebrado', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 502, headers: { get: () => 'text/html' }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    // D3: código desconhecido/ausente cai em erro GENÉRICO — nunca mais "retrato desatualizado"
    // por omissão (esse fallback desligava ações por um motivo que a resposta nem mandou).
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });

  it('NEGATIVO — código de erro fora do vocabulário conhecido cai no fallback GENÉRICO (DESCONHECIDO)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(422, { success: false, error: 'algo novo', code: 'CODIGO_NUNCA_VISTO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });

  it('NEGATIVO — corpo 200 sem o campo `success` (formato inesperado) é tratado como erro, nunca lido como sucesso', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { data: SNAPSHOT }));
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });

  it('NEGATIVO — 503 (GET) cujo corpo não é JSON válido cai no fallback de mensagem (safeJson captura o throw)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      headers: { get: () => 'application/json' },
      json: async () => {
        throw new Error('corpo corrompido');
      },
    } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ code: 'FONTE_NAO_CONFIGURADA', message: 'ANACARE_SOURCE_NOT_CONFIGURED' });
  });

  it('NEGATIVO — erro sem mensagem (`error` vazio) cai no fallback "HTTP <status>"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { success: false, error: '', code: 'CODIGO_NUNCA_VISTO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.getMonthSnapshot('2026-08')).rejects.toMatchObject({ message: 'HTTP 500' });
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

  it('NEGATIVO — 404 (mês sem retrato ainda) devolve snapshotState "nao_construido", nunca lança', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    const status = await service.getRetratoStatus('2099-01');
    expect(status).toEqual({ updatedAt: expect.any(String), stale: false, snapshotState: 'nao_construido', circuitBreakerOpen: false });
  });

  it('POSITIVO — propaga snapshotState do snapshot completo (item 3: não aproxima mais por `stale`)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { ...SNAPSHOT, stale: true, snapshotState: 'nao_construido' } }));
    const service = new AnaCareHoursHttpService();
    const status = await service.getRetratoStatus('2026-08');
    expect(status.snapshotState).toBe('nao_construido');
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

  it('NEGATIVO — content-type ausente (header.get devolve null) na escrita vira erro GENÉRICO', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.validateShift({ shiftId: 'shift-1' })).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });
});

describe('validateBatch', () => {
  // D1 (revisão de conformidade, 15/09): o backend real responde 200
  // `{success:true, data:{results}}` — NUNCA 204 — porque o lote é parcial (cada item tem seu
  // próprio `ok`/`code`, `AnaCareHoursService.ts` backend). O teste antigo mockava 204 e passava
  // mesmo com o bug do front (que só aceitava 204 como sucesso).
  it('POSITIVO — 200 com todos os itens ok resolve, body manda shiftIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { results: [{ shiftId: 's1', ok: true }, { shiftId: 's2', ok: true }] } }),
    );
    globalThis.fetch = fetchMock;
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1', 's2'] })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/shifts/validate-batch');
    expect(JSON.parse(init.body)).toEqual({ shiftIds: ['s1', 's2'] });
  });

  it('NEGATIVO — 200 com 1 item falho vira AnaCareHoursServiceError com o code daquele item', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { results: [{ shiftId: 's1', ok: true }, { shiftId: 's2', ok: false, code: 'JA_VALIDADO' }] } }),
    );
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1', 's2'] })).rejects.toMatchObject({ code: 'JA_VALIDADO' });
  });

  it('NEGATIVO — 503 (fonte não configurada) vira FONTE_NAO_CONFIGURADA', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(503, { success: false, error: 'ANACARE_SOURCE_NOT_CONFIGURED', code: 'ANACARE_SOURCE_NOT_CONFIGURED' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ code: 'FONTE_NAO_CONFIGURADA' });
  });

  it('NEGATIVO — resposta sem content-type JSON vira erro GENÉRICO, nunca `.json()` quebrado', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 502, headers: { get: () => 'text/html' }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });

  it('NEGATIVO — corpo com `success:false` (não é o formato {results}) vira erro mapeado pelo code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { success: false, error: 'lote inválido', code: 'TURNO_NAO_ENCONTRADO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ code: 'TURNO_NAO_ENCONTRADO' });
  });

  it('NEGATIVO — corpo `success:false` sem `error` cai no fallback "HTTP <status>"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(400, { success: false, error: '', code: 'TURNO_NAO_ENCONTRADO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ message: 'HTTP 400' });
  });

  it('NEGATIVO — 503 cujo corpo JSON não tem `error` cai no fallback padrão da mensagem', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({
      code: 'FONTE_NAO_CONFIGURADA',
      message: 'ANACARE_SOURCE_NOT_CONFIGURED',
    });
  });

  it('NEGATIVO — content-type ausente (header.get devolve null) no lote vira erro GENÉRICO', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.validateBatch({ shiftIds: ['s1'] })).rejects.toMatchObject({ code: 'DESCONHECIDO' });
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

  it('NEGATIVO — 503 cujo corpo não é JSON válido cai no fallback de mensagem (safeJson captura o throw)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      headers: { get: () => 'application/json' },
      json: async () => {
        throw new Error('corpo corrompido');
      },
    } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro' })).rejects.toMatchObject({
      code: 'FONTE_NAO_CONFIGURADA',
      message: 'ANACARE_SOURCE_NOT_CONFIGURED',
    });
  });

  it('NEGATIVO — resposta de erro sem content-type JSON (não 204/503) vira AnaCareHoursServiceError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, headers: { get: () => 'text/plain' }, json: async () => ({}) } as unknown as Response);
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro' })).rejects.toMatchObject({ code: 'DESCONHECIDO' });
  });

  it('NEGATIVO — erro de escrita sem mensagem cai no fallback "HTTP <status>"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(409, { success: false, error: '', code: 'JA_VALIDADO' }));
    const service = new AnaCareHoursHttpService();
    await expect(service.contestShift({ shiftId: 'shift-1', reason: 'otro' })).rejects.toMatchObject({ message: 'HTTP 409' });
  });
});
