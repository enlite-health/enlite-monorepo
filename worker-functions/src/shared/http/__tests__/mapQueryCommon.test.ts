/**
 * mapQueryCommon.test.ts — o que os dois mapas compartilham: escopo (lex C3),
 * `num()`, o 400 da borda, a trilha sem PII (C5) e o catch que só diz a origem.
 */
const mockReportError = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: { info: (...a: unknown[]) => mockLogInfo(...a), child: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: (...args: unknown[]) => mockReportError(...args),
  loggingAls: { run: jest.fn((_: unknown, fn: () => unknown) => fn()) },
}));

import { Request, Response } from 'express';
import { z } from 'zod';
import {
  MAX_MAP_POINTS, hasScope, mapScopeShape, num, parseMapBody, respondMapError, respondMapPoints, totalFromRows,
  withMapScopeRules,
} from '../mapQueryCommon';

function mockRes(): Response & { body: unknown; statusCode: number } {
  const res = { statusCode: 0, body: undefined as unknown } as Response & { body: unknown; statusCode: number };
  res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

const CABA = { lat: -34.6037, lng: -58.3816 };
const Schema = withMapScopeRules(z.object({ ...mapScopeShape, extra: z.string().optional() }).strict());

describe('MAX_MAP_POINTS (governança, 30/08)', () => {
  it('o teto é 500 — literal, para que mexer nele sem pensar quebre aqui', () => {
    // O CSV de /workers/export é adminOnly porque foi mal usado; o mapa é
    // staffOnly e não pode virar a mesma porta. Mexer no número é decisão, não
    // detalhe: se este teste ficar vermelho, é para alguém explicar o porquê.
    expect(MAX_MAP_POINTS).toBe(500);
    expect(Schema.safeParse({ country: 'AR', city: 'x', limit: 500 }).success).toBe(true);
    expect(Schema.safeParse({ country: 'AR', city: 'x', limit: 501 }).success).toBe(false);
    const dflt = Schema.safeParse({ country: 'AR', city: 'x' });
    expect(dflt.success && dflt.data.limit).toBe(500);
  });
});

describe('hasScope / withMapScopeRules (lex C3)', () => {
  it('escopo = centro+raio, ou state, ou city', () => {
    expect(hasScope({})).toBe(false);
    expect(hasScope({ center: CABA })).toBe(false);
    expect(hasScope({ radius_km: 5 })).toBe(false);
    expect(hasScope({ center: CABA, radius_km: 5 })).toBe(true);
    expect(hasScope({ state: 'x' })).toBe(true);
    expect(hasScope({ city: 'x' })).toBe(true);
  });

  it('schema: sem escopo é inválido; raio sem centro é inválido; limit nasce no teto', () => {
    expect(Schema.safeParse({ country: 'AR' }).success).toBe(false);
    expect(Schema.safeParse({ country: 'AR', state: 'x', radius_km: 5 }).success).toBe(false);
    expect(Schema.safeParse({ country: 'AR', center: CABA, radius_km: 5, limit: MAX_MAP_POINTS + 1 }).success).toBe(false);
    expect(Schema.safeParse({ country: 'US', city: 'x' }).success).toBe(false);
    const ok = Schema.safeParse({ country: 'BR', city: ' São Paulo ' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ country: 'BR', city: 'São Paulo', limit: MAX_MAP_POINTS });
  });
});

describe('num', () => {
  it('string numérica, número, null/undefined e lixo', () => {
    expect(num('-34.6')).toBe(-34.6);
    expect(num(2)).toBe(2);
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('abc')).toBeNull();
  });
});

describe('totalFromRows', () => {
  it('lê o COUNT(*) OVER() da primeira linha (número ou string); sem linha, 0', () => {
    expect(totalFromRows([{ total_count: 4231 }, { total_count: 4231 }])).toBe(4231);
    expect(totalFromRows([{ total_count: '4231' }])).toBe(4231);
    expect(totalFromRows([])).toBe(0);
    expect(totalFromRows([{ total_count: null }])).toBe(0);
    expect(totalFromRows([{}])).toBe(0);
  });
});

describe('parseMapBody', () => {
  it('corpo válido volta tipado; inválido (ou ausente) responde 400 e volta null', () => {
    const okRes = mockRes();
    expect(parseMapBody(Schema, { body: { country: 'AR', city: 'x' } } as Request, okRes)).toEqual({ country: 'AR', city: 'x', limit: MAX_MAP_POINTS });
    expect(okRes.status).not.toHaveBeenCalled();

    const badRes = mockRes();
    expect(parseMapBody(Schema, { body: { country: 'AR' } } as Request, badRes)).toBeNull();
    expect(badRes.statusCode).toBe(400);
    expect(badRes.body).toMatchObject({ success: false, error: 'Invalid map filters' });

    const noBody = mockRes();
    expect(parseMapBody(Schema, {} as Request, noBody)).toBeNull();
    expect(noBody.statusCode).toBe(400);
  });
});

describe('respondMapPoints (lex C5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('total vem do BANCO (não do array), truncated é a diferença, e o log conta o que SAIU — sem coordenada/nome/UUID', () => {
    const res = mockRes();
    const data = [{ id: 'u-1', name: 'Ana', lat: -34.6, lng: -58.4 }, { id: 'u-2', name: 'Bia', lat: null, lng: null }];
    respondMapPoints({ user: { uid: 'staff-9' } } as Request, res, 'x.map.read', { country: 'AR', center: CABA }, data, 4231);
    expect(res.statusCode).toBe(200);
    // 2 pontos vieram, 4231 existem: a tela diz a verdade e avisa que está cortada.
    expect(res.body).toEqual({ success: true, data, total: 4231, withoutCoordinates: 1, truncated: true });
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const entry = mockLogInfo.mock.calls[0][0];
    // `n` é o que saiu; o log NÃO ganhou campo novo (nada de PII a mais).
    expect(entry).toEqual({ msg: 'x.map.read', uid: 'staff-9', country: 'AR', scope: 'radius', n: 2, withoutCoordinates: 1, truncated: true });
    expect(JSON.stringify(entry)).not.toMatch(/34\.6|58\.3|Ana|Bia|u-1/);
  });

  it('total igual ao que veio → truncated false, mesmo com a lista cheia', () => {
    const res = mockRes();
    const data = Array.from({ length: MAX_MAP_POINTS }, (_, k) => ({ id: `u-${k}`, lat: -34.6 }));
    respondMapPoints({ user: { uid: 'staff-9' } } as Request, res, 'x.map.read', { country: 'AR' }, data, MAX_MAP_POINTS);
    expect(res.body).toMatchObject({ total: MAX_MAP_POINTS, truncated: false });
  });

  it('sem req.user → uid null; sem centro → scope location; sem linha → total 0', () => {
    const res = mockRes();
    respondMapPoints({} as Request, res, 'y.map.read', { country: 'BR' }, [], 0);
    expect(mockLogInfo.mock.calls[0][0]).toEqual({ msg: 'y.map.read', uid: null, country: 'BR', scope: 'location', n: 0, withoutCoordinates: 0, truncated: false });
    expect(res.body).toEqual({ success: true, data: [], total: 0, withoutCoordinates: 0, truncated: false });
  });
});

describe('respondMapError', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Error e não-Error: 500 com a mensagem pedida e o log só com a origem', () => {
    const res = mockRes();
    respondMapError(res, new Error('boom'), 'X:get', 'Failed X');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed X' });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'X:get' });

    respondMapError(mockRes(), 42, 'Y:get', 'Failed Y');
    expect((mockReportError.mock.calls[1][0] as Error).message).toBe('42');
    expect(mockReportError.mock.calls[1][1]).toEqual({ source: 'Y:get' });
  });
});
