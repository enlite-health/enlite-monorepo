/**
 * AdminWorkersMapController.test.ts
 *
 * O banco só entra no e2e; aqui a régua é o TEXTO do SQL + a ordem dos params
 * (buildWorkersMapQuery) e o contrato HTTP (getMapPoints) — inclusive as
 * condições do lex de 29/08: C1 (strict), C3 (escopo obrigatório + truncated),
 * C4 (country), C5 (trilha sem coordenada/nome).
 */
const mockQuery = jest.fn();
const mockDecrypt = jest.fn();
const mockReportError = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: { info: (...a: unknown[]) => mockLogInfo(...a), child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), warn: jest.fn(), error: jest.fn() },
  reportError: (...args: unknown[]) => mockReportError(...args),
  loggingAls: { run: jest.fn((_: unknown, fn: () => unknown) => fn()) },
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockQuery }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));

import { Request, Response } from 'express';
import {
  AdminWorkersMapController,
  buildWorkersMapQuery,
  WorkersMapBodySchema,
  MAX_MAP_POINTS,
} from '../AdminWorkersMapController';

function mockRes(): Response & { body: unknown; statusCode: number } {
  const res = { statusCode: 0, body: undefined as unknown } as Response & { body: unknown; statusCode: number };
  res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

const CABA = { lat: -34.6037, lng: -58.3816 };
const SCOPE = { country: 'AR', center: CABA, radius_km: 5 };

function parse(body: Record<string, unknown>) {
  const r = WorkersMapBodySchema.safeParse(body);
  if (!r.success) throw new Error(JSON.stringify(r.error.flatten()));
  return r.data;
}
const req = (body: unknown, uid = 'staff-1') => ({ body, user: { uid } }) as unknown as Request;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1', email: 'w1@test.local', first_name_encrypted: 'Zm9v', last_name_encrypted: 'YmFy',
  status: 'REGISTERED', profession: 'AT', latitude: '-34.6', longitude: '-58.4',
  city: 'CABA', neighborhood: 'Palermo', state: 'Buenos Aires', distance_km: null, ...over,
});

describe('WorkersMapBodySchema (lex C1/C3/C4)', () => {
  it('country é obrigatório', () => {
    expect(WorkersMapBodySchema.safeParse({ center: CABA, radius_km: 5 }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'US', center: CABA, radius_km: 5 }).success).toBe(false);
  });
  it('escopo obrigatório: sem centro+raio nem state/city → inválido', () => {
    expect(WorkersMapBodySchema.safeParse({ country: 'AR' }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', center: CABA }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', radius_km: 5 }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', state: 'Buenos Aires' }).success).toBe(true);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', city: 'La Plata' }).success).toBe(true);
    expect(WorkersMapBodySchema.safeParse(SCOPE).success).toBe(true);
  });
  it('strict: parâmetro desconhecido (inclusive clínico) é rejeitado', () => {
    for (const extra of ['clinical_specialty', 'dependency_level', 'attention_reason', 'needs_attention', 'diagnosis', 'foo']) {
      expect(WorkersMapBodySchema.safeParse({ ...SCOPE, [extra]: 'x' }).success).toBe(false);
    }
    expect(WorkersMapBodySchema.safeParse({ ...SCOPE, center: { ...CABA, extra: 1 } }).success).toBe(false);
  });
  it('limites: raio 1..100, limit ≤ teto, coordenadas dentro do globo', () => {
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', center: CABA, radius_km: 0 }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', center: CABA, radius_km: 101 }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ ...SCOPE, limit: MAX_MAP_POINTS + 1 }).success).toBe(false);
    expect(WorkersMapBodySchema.safeParse({ country: 'AR', center: { lat: 91, lng: 0 }, radius_km: 5 }).success).toBe(false);
    expect(parse(SCOPE).limit).toBe(MAX_MAP_POINTS);
  });
  it('status só aceita o enum', () => {
    expect(WorkersMapBodySchema.safeParse({ ...SCOPE, status: ['foo'] }).success).toBe(false);
    expect(parse({ ...SCOPE, status: ['DISABLED'] }).status).toEqual(['DISABLED']);
  });
});

describe('buildWorkersMapQuery', () => {
  it('escopo por localidade: exclui DISABLED pela regra da casa, ANY dos status ativos, país, sem raio', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', state: 'Buenos Aires' }));
    expect(sql).toContain("COALESCE(w.status, '') <> 'DISABLED'");
    expect(sql).toContain('EXISTS (SELECT 1 FROM worker_service_areas wsa');
    expect(sql).toContain('w.status = ANY($2::text[])');
    expect(sql).toContain('w.country = $3');
    expect(params.slice(1)).toEqual([['REGISTERED', 'INCOMPLETE_REGISTER'], 'AR', MAX_MAP_POINTS]);
    expect(sql).toContain('NULL::numeric AS distance_km');
    expect(sql).not.toContain('ST_DWithin');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('s.deleted_at IS NULL');
    expect(sql).toContain('LIMIT $4');
  });

  it('status vazio cai no default; lista explícita passa como veio', () => {
    expect(buildWorkersMapQuery(parse({ ...SCOPE, status: [] })).params[0]).toEqual(['REGISTERED', 'INCOMPLETE_REGISTER']);
    expect(buildWorkersMapQuery(parse({ ...SCOPE, status: ['INCOMPLETE_REGISTER'] })).params[0]).toEqual(['INCOMPLETE_REGISTER']);
  });

  it('pedido com DISABLED troca o exclude da casa por TRUE (senão contradiz o pedido)', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ ...SCOPE, status: ['DISABLED', 'REGISTERED'] }));
    expect(sql).not.toContain("<> 'DISABLED'");
    expect(sql).toContain('AND TRUE');
    expect(params[0]).toEqual(['DISABLED', 'REGISTERED']);
  });

  it('docs_complete/profession/state/city reaproveitam o WHERE da lista', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', docs_complete: 'incomplete', profession: ['AT', 'NURSE'], state: 'Buenos Aires', city: 'La Plata' }));
    expect(sql).toContain("w.status = 'INCOMPLETE_REGISTER'");
    expect(sql).toContain('w.profession = ANY(');
    expect(sql.match(/EXISTS \(SELECT 1 FROM worker_service_areas wsa/g)?.length).toBe(2);
    expect(params).toContainEqual(['AT', 'NURSE']);
  });

  it('docs_validated acrescenta a cláusula sobre wd', () => {
    expect(buildWorkersMapQuery(parse({ ...SCOPE, docs_validated: 'all_validated' })).sql).toContain('wd.');
    expect(buildWorkersMapQuery(parse({ ...SCOPE, docs_validated: 'pending_validation' })).sql).toContain('wd.');
  });

  it('centro sem raio (com state como escopo): distância calculada, sem filtro de raio', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', state: 'Buenos Aires', center: { lat: -34.6, lng: -58.4 } }));
    expect(sql).toContain('ST_Distance(wsa.location, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography) / 1000.0 AS distance_km');
    expect(sql).not.toContain('ST_DWithin');
    // ordem: lng antes de lat (ST_MakePoint(x=lng, y=lat))
    expect(params.slice(1)).toEqual([['REGISTERED', 'INCOMPLETE_REGISTER'], 'AR', -58.4, -34.6, MAX_MAP_POINTS]);
  });

  it('centro + raio: ST_DWithin em METROS e quem não tem coordenada NÃO é excluído', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', center: { lat: -34.6, lng: -58.4 }, radius_km: 5, limit: 10 }));
    expect(sql).toContain('(wsa.location IS NULL OR ST_DWithin(wsa.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5))');
    expect(params).toEqual([['REGISTERED', 'INCOMPLETE_REGISTER'], 'AR', -58.4, -34.6, 5000, 10]);
    expect(sql).toContain('LIMIT $6');
  });
});

describe('AdminWorkersMapController.getMapPoints', () => {
  let controller: AdminWorkersMapController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockDecrypt.mockImplementation(async (v: string | null) => (v ? Buffer.from(v, 'base64').toString('utf8') : ''));
    controller = new AdminWorkersMapController();
  });

  it('400 em corpo inválido / sem escopo / sem corpo, sem tocar no banco nem logar', async () => {
    for (const body of [undefined, {}, { country: 'AR' }, { ...SCOPE, diagnosis: 'x' }]) {
      const res = mockRes();
      await controller.getMapPoints(req(body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('200: pontos com nome descriptografado, documentsComplete por status, sem-coordenada contado, truncated no teto', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row(),
      row({ id: 'w2', status: 'INCOMPLETE_REGISTER', latitude: null, longitude: null, first_name_encrypted: null, last_name_encrypted: null, email: 'semnome@test.local', profession: null, city: null, neighborhood: null, state: null }),
      row({ id: 'w3', latitude: 'abc', longitude: '-58.4', distance_km: '1.5' }),
    ] });
    const res = mockRes();
    await controller.getMapPoints(req({ ...SCOPE, limit: 3 }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Array<Record<string, unknown>>; total: number; withoutCoordinates: number; truncated: boolean };
    expect(body.total).toBe(3);
    expect(body.withoutCoordinates).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.data[0]).toEqual({ id: 'w1', name: 'foo bar', lat: -34.6, lng: -58.4, status: 'REGISTERED', documentsComplete: true, profession: 'AT', city: 'CABA', neighborhood: 'Palermo', state: 'Buenos Aires', distanceKm: null });
    expect(body.data[1]).toMatchObject({ id: 'w2', name: 'semnome@test.local', lat: null, lng: null, documentsComplete: false, profession: null, city: null, distanceKm: null });
    // latitude não numérica = sem coordenada (e a distância não vaza)
    expect(body.data[2]).toMatchObject({ id: 'w3', lat: null, lng: null, distanceKm: null });
    // nada de telefone/documento no payload
    expect(JSON.stringify(body)).not.toMatch(/phone|document_number|email_bidx/);
  });

  it('trilha de leitura (lex C5): uid, país, escopo e contagens — sem coordenada, nome ou UUID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ distance_km: '2.25' })] });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE, 'uid-abc'), res);
    const body = res.body as { data: Array<{ distanceKm: number | null }>; truncated: boolean };
    expect(body.data[0].distanceKm).toBe(2.25);
    expect(body.truncated).toBe(false);
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const entry = mockLogInfo.mock.calls[0][0];
    expect(entry).toEqual({ msg: 'workers.map.read', uid: 'uid-abc', country: 'AR', scope: 'radius', n: 1, withoutCoordinates: 0, truncated: false });
    expect(JSON.stringify(entry)).not.toMatch(/34\.6|58\.3|foo|w1/);
  });

  it('trilha com escopo por localidade e sem req.user → uid null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = mockRes();
    await controller.getMapPoints({ body: { country: 'BR', city: 'Curitiba' } } as unknown as Request, res);
    expect(mockLogInfo.mock.calls[0][0]).toMatchObject({ uid: null, country: 'BR', scope: 'location', n: 0 });
  });

  it('descriptografa em lotes (mais de 25 linhas → mais de uma rodada) e preserva a ordem', async () => {
    const rows = Array.from({ length: 60 }, (_, k) => row({ id: `w${k}`, first_name_encrypted: Buffer.from(`n${k}`).toString('base64'), last_name_encrypted: null }));
    mockQuery.mockResolvedValueOnce({ rows });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const body = res.body as { data: Array<{ id: string; name: string }> };
    expect(body.data.map((p) => p.id)).toEqual(rows.map((r) => r.id));
    expect(body.data[59].name).toBe('n59');
    expect(mockDecrypt).toHaveBeenCalledTimes(120);
  });

  it('500: o log de erro leva só a origem — nenhum filtro, nome ou coordenada', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const res = mockRes();
    await controller.getMapPoints(req({ ...SCOPE, city: 'Palermo' }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to load workers map' });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminWorkersMapController:getMapPoints' });
    expect(JSON.stringify(mockReportError.mock.calls[0][1])).not.toMatch(/34\.6|Palermo/);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('500 com erro não-Error', async () => {
    mockQuery.mockRejectedValueOnce('string-err');
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    expect(res.statusCode).toBe(500);
    expect((mockReportError.mock.calls[0][0] as Error).message).toBe('string-err');
  });
});
