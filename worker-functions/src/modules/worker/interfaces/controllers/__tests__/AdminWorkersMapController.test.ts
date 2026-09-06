/**
 * AdminWorkersMapController.test.ts
 *
 * O banco só entra no e2e; aqui a régua é o TEXTO do SQL + a ordem dos params
 * (buildWorkersMapQuery) e o contrato HTTP (getMapPoints) — inclusive as
 * condições do lex de 29/08: C1 (strict), C3 (escopo obrigatório + truncated),
 * C4 (country), C5 (trilha sem coordenada/nome — allowlist FECHADA, com
 * catálogo e geohash-5) e C6 (nenhum identificador na linha do geohash). O que é comum aos dois mapas
 * (escopo, num, 400, trilha, catch) tem teste próprio em mapQueryCommon.test.
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
import { resolveLocationFilter } from '@shared/utils/normalizeLocationValue';
import { geohash5 } from '@shared/utils/geohash';
import {
  AdminWorkersMapController,
  buildWorkersMapQuery,
  WorkersMapBodySchema,
  MAX_MAP_POINTS,
  DECRYPT_BATCH,
} from '../AdminWorkersMapController';

function mockRes(): Response & { body: unknown; statusCode: number } {
  const res = { statusCode: 0, body: undefined as unknown } as Response & { body: unknown; statusCode: number };
  res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

const CABA = { lat: -34.6037, lng: -58.3816 };
const SCOPE = { country: 'AR', center: CABA, radius_km: 5 };
const ACTIVE = ['REGISTERED', 'INCOMPLETE_REGISTER'];
/** Só o WHERE (o SELECT também cita w.status como coluna). */
const whereOf = (sql: string): string => sql.slice(sql.indexOf('WHERE w.merged_into_id'));

function parse(body: Record<string, unknown>) {
  const r = WorkersMapBodySchema.safeParse(body);
  if (!r.success) throw new Error(JSON.stringify(r.error.flatten()));
  return r.data;
}
const req = (body: unknown, uid = 'staff-1') => ({ body, user: { uid } }) as unknown as Request;

// A linha do banco traz e-mail de propósito: o teste prova que ele NUNCA chega ao payload.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1', email: 'w1@test.local', first_name_encrypted: 'Zm9v', last_name_encrypted: 'YmFy',
  status: 'REGISTERED', profession: 'AT', latitude: '-34.6', longitude: '-58.4',
  city: 'CABA', neighborhood: 'Palermo', state: 'Buenos Aires', distance_km: null, total_count: 1, ...over,
});

/** `COUNT(*) OVER()` é igual em TODA linha: é o total do filtro, não o da página. */
const withTotal = <R extends object>(total: number, rows: R[]): Array<R & { total_count: number }> => rows.map((r) => ({ ...r, total_count: total }));

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
  it('escopo por localidade: ANY dos status ativos (sem o exclude da casa, que seria redundante), país, sem raio', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', state: 'Buenos Aires' }));
    expect(sql).not.toContain("<> 'DISABLED'");
    expect(sql).toContain('w.status = ANY($1::text[])');
    expect(sql).toContain('EXISTS (SELECT 1 FROM worker_service_areas wsa');
    expect(sql).toContain('w.country = $3');
    expect(params[0]).toEqual(ACTIVE);
    expect(params[2]).toBe('AR');
    expect(params[params.length - 1]).toBe(MAX_MAP_POINTS);
    expect(sql).toContain('NULL::numeric AS distance_km');
    expect(sql).not.toContain('ST_DWithin');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('s.deleted_at IS NULL');
    expect(sql).toContain(`LIMIT $${params.length}`);
  });

  it('status vazio cai no default; lista explícita passa como veio — inclusive DISABLED, sem cláusula contraditória', () => {
    expect(buildWorkersMapQuery(parse({ ...SCOPE, status: [] })).params[0]).toEqual(ACTIVE);
    expect(buildWorkersMapQuery(parse({ ...SCOPE, status: ['INCOMPLETE_REGISTER'] })).params[0]).toEqual(['INCOMPLETE_REGISTER']);
    const { sql, params } = buildWorkersMapQuery(parse({ ...SCOPE, status: ['DISABLED', 'REGISTERED'] }));
    expect(sql).not.toContain("<> 'DISABLED'");
    expect(sql).not.toContain('AND TRUE');
    expect(whereOf(sql).match(/w\.status/g)?.length).toBe(1);
    expect(params[0]).toEqual(['DISABLED', 'REGISTERED']);
  });

  it('DISABLED + docs_complete=incomplete: interseção vazia (lista vazia no ANY), nunca `status = X AND status = ANY`', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ ...SCOPE, status: ['DISABLED'], docs_complete: 'incomplete' }));
    expect(whereOf(sql).match(/w\.status/g)?.length).toBe(1);
    expect(sql).not.toContain("w.status = 'INCOMPLETE_REGISTER'");
    expect(params[0]).toEqual([]);
  });

  it('docs_complete restringe o default por interseção; profession/state/city reaproveitam o WHERE da lista', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', docs_complete: 'incomplete', profession: ['AT', 'NURSE'], state: 'Buenos Aires', city: 'La Plata' }));
    expect(params[0]).toEqual(['INCOMPLETE_REGISTER']);
    expect(sql).toContain('w.profession = ANY(');
    expect(sql.match(/EXISTS \(SELECT 1 FROM worker_service_areas wsa/g)?.length).toBe(2);
    expect(params).toContainEqual(['AT', 'NURSE']);
  });

  it('LATERAL com filtro de state/city: a área que casa o filtro vence, depois quem tem coordenada, depois a mais recente', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', state: 'Córdoba', city: 'Villa Carlos Paz' }));
    const lateral = sql.slice(sql.indexOf('LEFT JOIN LATERAL'), sql.indexOf(') wsa ON true'));
    const order = lateral.slice(lateral.indexOf('ORDER BY'));
    // mesmo predicado do EXISTS da lista, só que sobre o alias `s` do LATERAL
    expect(order).toMatch(/ORDER BY \(lower\(btrim\(s\.state\)\) = ANY\(\$\d+::text\[\]\) OR lower\(btrim\(s\.work_zone\)\) = ANY\(\$\d+::text\[\]\)\) DESC NULLS LAST, \(lower\(btrim\(s\.city\)\) = ANY\(\$\d+::text\[\]\) OR lower\(btrim\(s\.work_zone\)\) = ANY\(\$\d+::text\[\]\)\) DESC NULLS LAST, \(s\.latitude IS NULL\), s\.updated_at DESC/);
    // os params do LATERAL carregam as mesmas chaves normalizadas que o EXISTS
    const stateParam = Number(order.match(/s\.state\)\) = ANY\(\$(\d+)/)![1]);
    const cityParam = Number(order.match(/s\.city\)\) = ANY\(\$(\d+)/)![1]);
    expect(params[stateParam - 1]).toEqual(resolveLocationFilter('Córdoba').exactKeys);
    expect(params[cityParam - 1]).toEqual(resolveLocationFilter('Villa Carlos Paz').exactKeys);
    // e são os MESMOS valores que o EXISTS da lista recebeu (mesma normalização)
    expect(params.filter((p) => JSON.stringify(p) === JSON.stringify(params[stateParam - 1]))).toHaveLength(2);
    expect(params.filter((p) => JSON.stringify(p) === JSON.stringify(params[cityParam - 1]))).toHaveLength(2);
  });

  it('LATERAL sem filtro de localidade: só coordenada e recência', () => {
    const { sql } = buildWorkersMapQuery(parse(SCOPE));
    expect(sql).toContain('ORDER BY (s.latitude IS NULL), s.updated_at DESC\n      LIMIT 1');
  });

  it('docs_validated acrescenta a cláusula sobre wd', () => {
    expect(buildWorkersMapQuery(parse({ ...SCOPE, docs_validated: 'all_validated' })).sql).toContain('wd.');
    expect(buildWorkersMapQuery(parse({ ...SCOPE, docs_validated: 'pending_validation' })).sql).toContain('wd.');
  });

  it('centro sem raio (com state como escopo): distância calculada, sem filtro de raio', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', state: 'Buenos Aires', center: { lat: -34.6, lng: -58.4 } }));
    expect(sql).toMatch(/ST_Distance\(wsa\.location, ST_SetSRID\(ST_MakePoint\(\$\d+, \$\d+\), 4326\)::geography\) \/ 1000\.0 AS distance_km/);
    expect(sql).not.toContain('ST_DWithin');
    // ordem: lng antes de lat (ST_MakePoint(x=lng, y=lat)), depois o limit
    expect(params.slice(-3)).toEqual([-58.4, -34.6, MAX_MAP_POINTS]);
  });

  it('centro + raio: ST_DWithin em METROS e quem não tem coordenada NÃO é excluído', () => {
    const { sql, params } = buildWorkersMapQuery(parse({ country: 'AR', center: { lat: -34.6, lng: -58.4 }, radius_km: 5, limit: 10 }));
    expect(sql).toContain('(wsa.location IS NULL OR ST_DWithin(wsa.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5))');
    expect(params).toEqual([ACTIVE, 'AR', -58.4, -34.6, 5000, 10]);
    expect(sql).toContain('LIMIT $6');
  });

  it('a contagem sai do banco: COUNT(*) OVER() no SELECT, antes do LIMIT — e sem param novo', () => {
    const { sql, params } = buildWorkersMapQuery(parse(SCOPE));
    expect(sql).toContain('COUNT(*) OVER()::int AS total_count');
    // a window está no SELECT (roda sobre o filtro inteiro) e o LIMIT vem depois
    expect(sql.indexOf('COUNT(*) OVER()')).toBeLessThan(sql.indexOf('FROM workers'));
    expect(sql.indexOf('COUNT(*) OVER()')).toBeLessThan(sql.lastIndexOf('LIMIT $'));
    expect(params).toEqual([ACTIVE, 'AR', CABA.lng, CABA.lat, 5000, MAX_MAP_POINTS]);
  });

  it('o SELECT não pede e-mail, telefone nem documento', () => {
    const { sql } = buildWorkersMapQuery(parse(SCOPE));
    expect(sql.slice(0, sql.indexOf('FROM workers'))).not.toMatch(/email|phone|document/);
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

  it('200: nome descriptografado, documentsComplete por status, sem-coordenada contado, limit cheio sem corte — e o e-mail NUNCA sai', async () => {
    mockQuery.mockResolvedValueOnce({ rows: withTotal(4, [
      row(),
      row({ id: 'w2', status: 'INCOMPLETE_REGISTER', latitude: null, longitude: null, first_name_encrypted: null, last_name_encrypted: null, email: 'semnome@test.local', profession: null, city: null, neighborhood: null, state: null }),
      row({ id: 'w3', latitude: 'abc', longitude: '-58.4', distance_km: '1.5' }),
      // o driver pode entregar número (coluna double) em vez de string
      row({ id: 'w4', latitude: -34.7, longitude: -58.5, distance_km: 2 }),
    ]) });
    const res = mockRes();
    await controller.getMapPoints(req({ ...SCOPE, limit: 4 }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Array<Record<string, unknown>>; total: number; withoutCoordinates: number; truncated: boolean };
    expect(body.total).toBe(4);
    expect(body.withoutCoordinates).toBe(2);
    // 4 vieram e 4 existem: encheu o limit e mesmo assim NÃO está cortado.
    expect(body.truncated).toBe(false);
    expect(body.data[0]).toEqual({ id: 'w1', name: 'foo bar', lat: -34.6, lng: -58.4, status: 'REGISTERED', documentsComplete: true, profession: 'AT', city: 'CABA', neighborhood: 'Palermo', state: 'Buenos Aires', distanceKm: null });
    // sem nome → '—', e não o e-mail
    expect(body.data[1]).toMatchObject({ id: 'w2', name: '—', lat: null, lng: null, documentsComplete: false, profession: null, city: null, distanceKm: null });
    // latitude não numérica = sem coordenada (e a distância não vaza)
    expect(body.data[2]).toMatchObject({ id: 'w3', lat: null, lng: null, distanceKm: null });
    expect(body.data[3]).toMatchObject({ id: 'w4', lat: -34.7, lng: -58.5, distanceKm: 2 });
    // nada de e-mail, telefone ou documento no payload — em nenhum campo
    expect(JSON.stringify(body)).not.toMatch(/@|test\.local|phone|document_number|email/);
  });

  it('trilha de leitura (lex C5/C6): allowlist FECHADA — escopo, catálogo e geohash-5, sem coordenada, nome ou UUID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ distance_km: '2.25' })] });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE, 'uid-abc'), res);
    const body = res.body as { data: Array<{ distanceKm: number | null }>; truncated: boolean };
    expect(body.data[0].distanceKm).toBe(2.25);
    expect(body.truncated).toBe(false);
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const entry = mockLogInfo.mock.calls[0][0];
    // Lista COMPLETA: campo novo no log é decisão de privacidade e reprova aqui.
    expect(entry).toEqual({
      msg: 'workers.map.read', uid: 'uid-abc', country: 'AR', scope: 'radius',
      n: 1, withoutCoordinates: 0, truncated: false,
      totalMatching: 1, status: null, profession: null,
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false,
      radiusKm: 5, geohash5: '69y7p',
    });
    // a casa vira CÉLULA: o geohash tem 5 caracteres e a coordenada crua some
    expect((entry as { geohash5: string }).geohash5).toHaveLength(5);
    expect((entry as { geohash5: string }).geohash5).toBe(geohash5(CABA.lat, CABA.lng));
    expect(JSON.stringify(entry)).not.toContain(String(CABA.lat));
    expect(JSON.stringify(entry)).not.toContain(String(CABA.lng));
    expect(JSON.stringify(entry)).not.toMatch(/34\.6|58\.3|foo|bar|w1|Palermo/);
    expect(JSON.stringify(entry)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const chave of ['id', 'workerId', 'patientId', 'name', 'lat', 'lng', 'center']) {
      expect(entry).not.toHaveProperty(chave);
    }
  });

  it('trilha com filtro de catálogo: status, profession, localidade NAO vai ao log como texto: so o booleano (o valor livre fica fora)', async () => {
    // O que a trilha tem de permitir reconstruir é o ESCOPO da varredura:
    // "quem, de onde, com que filtro, quantos existiam". Status e profissão são
    // catálogo (enum fechado / código de profissão), não dado de pessoa.
    mockQuery.mockResolvedValueOnce({ rows: withTotal(4231, [row()]) });
    const res = mockRes();
    await controller.getMapPoints(req({
      country: 'AR', state: 'Buenos Aires', city: 'La Plata',
      status: ['REGISTERED', 'DISABLED'], profession: ['AT', 'NURSE'],
    }, 'uid-cat'), res);
    expect(res.statusCode).toBe(200);
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'workers.map.read', uid: 'uid-cat', country: 'AR', scope: 'location',
      n: 1, withoutCoordinates: 0, truncated: true,
      totalMatching: 4231,
      status: ['REGISTERED', 'DISABLED'], profession: ['AT', 'NURSE'],
      stateCanonical: null, hasStateFilter: true, hasCityFilter: true,
      // sem centro não há geocódigo NENHUM — nem grosso.
      radiusKm: null, geohash5: null,
    });
  });

  it('REPROVA identificador na trilha: nenhum UUID de resultado entra no objeto logado', async () => {
    // C6: o geohash só é admissível porque não há identificador na MESMA linha.
    const uuid = '9f1c2e30-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: uuid })] });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const entry = mockLogInfo.mock.calls[0][0] as Record<string, unknown>;
    expect((res.body as { data: Array<{ id: string }> }).data[0].id).toBe(uuid); // ele EXISTE na resposta
    expect(JSON.stringify(entry)).not.toContain(uuid);                           // e NÃO no log
    for (const chave of ['id', 'workerId', 'ids', 'data', 'points']) expect(entry).not.toHaveProperty(chave);
  });

  it('descriptografa só cifra não nula, em lotes, numa passada só, preservando a ordem', async () => {
    const rows = withTotal(120, Array.from({ length: 120 }, (_, k) => row({ id: `w${k}`, first_name_encrypted: Buffer.from(`n${k}`).toString('base64'), last_name_encrypted: k % 2 === 0 ? null : Buffer.from(`s${k}`).toString('base64') })));
    let inFlight = 0; let maxInFlight = 0;
    mockDecrypt.mockImplementation(async (v: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return Buffer.from(v, 'base64').toString('utf8');
    });
    mockQuery.mockResolvedValueOnce({ rows });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const body = res.body as { data: Array<{ id: string; name: string }> };
    expect(body.data.map((p) => p.id)).toEqual(rows.map((r) => r.id));
    expect(body.data[0].name).toBe('n0');
    expect(body.data[119].name).toBe('n119 s119');
    // 120 nomes + 60 sobrenomes = 180 cifras; os 60 nulos não vão ao KMS
    expect(mockDecrypt).toHaveBeenCalledTimes(180);
    expect(mockDecrypt).not.toHaveBeenCalledWith(null);
    expect(maxInFlight).toBe(DECRYPT_BATCH);
  });

  it('teto 500: a lista corta, a CONTAGEM não — total vem do COUNT(*) OVER(), truncated marca o corte', async () => {
    // O cenário que a mudança de 30/08 expõe: o filtro casa 4231 prestadores e
    // o teto deixa passar 500. Se `total` fosse `data.length`, a tela diria
    // "500 en 25 km" havendo 4231 — o número da tela viraria o tamanho da página.
    const rows = withTotal(4231, Array.from({ length: MAX_MAP_POINTS }, (_, k) => row({ id: `w${k}` })));
    mockQuery.mockResolvedValueOnce({ rows });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const body = res.body as { data: unknown[]; total: number; truncated: boolean };
    expect(MAX_MAP_POINTS).toBe(500);
    expect(mockQuery.mock.calls[0][1].at(-1)).toBe(500); // o LIMIT que foi ao banco
    expect(mockQuery.mock.calls[0][0]).toContain('COUNT(*) OVER()::int AS total_count');
    expect(body.data).toHaveLength(500);
    expect(body.total).toBe(4231);
    expect(body.total).not.toBe(body.data.length);
    expect(body.truncated).toBe(true);
    // o log conta o que SAIU (500) e, agora, o que EXISTIA (4231) — é
    // `totalMatching` que revela o tamanho real da varredura; `n` sozinho não.
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'workers.map.read', uid: 'staff-1', country: 'AR', scope: 'radius',
      n: 500, withoutCoordinates: 0, truncated: true,
      totalMatching: 4231, status: null, profession: null,
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false,
      radiusKm: 5, geohash5: '69y7p',
    });
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
});
