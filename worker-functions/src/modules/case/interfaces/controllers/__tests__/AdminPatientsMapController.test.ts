/**
 * AdminPatientsMapController.test.ts
 *
 * Régua: TEXTO do SQL + ordem dos params + contrato HTTP. E as travas do lex
 * de 29/08: C1 (sem coluna nem filtro clínico — strict), C3 (escopo +
 * truncated), C4 (country), C5 (trilha sem coordenada/nome — allowlist
 * FECHADA, com catálogo e geohash-5) e C6 (nenhum identificador na linha).
 */
const mockQuery = jest.fn();
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

import { Request, Response } from 'express';
import {
  AdminPatientsMapController,
  buildPatientsMapQuery,
  PatientsMapBodySchema,
  MAX_PATIENT_MAP_POINTS,
} from '../AdminPatientsMapController';
import { LIVE_JOB_POSTING_SQL, OPEN_JOB_STATUSES } from '@modules/matching/domain/openJobStatuses';
import { geohash5 } from '@shared/utils/geohash';

function mockRes(): Response & { body: unknown; statusCode: number } {
  const res = { statusCode: 0, body: undefined as unknown } as Response & { body: unknown; statusCode: number };
  res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

const CABA = { lat: -34.6037, lng: -58.3816 };
const SCOPE = { country: 'AR', center: CABA, radius_km: 5 };

function parse(body: Record<string, unknown>) {
  const r = PatientsMapBodySchema.safeParse(body);
  if (!r.success) throw new Error(JSON.stringify(r.error.flatten()));
  return r.data;
}
const req = (body: unknown, uid = 'staff-1') => ({ body, user: { uid } }) as unknown as Request;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', first_name: 'Ana', last_name: 'Paz', status: 'ACTIVE', address_id: 'a1', address_type: 'primary',
  lat: '-34.60', lng: '-58.38', city: 'CABA', neighborhood: 'Flores', state: 'Buenos Aires', open_vacancies: '2',
  distance_km: null, total_count: 1, ...over,
});

/** `COUNT(*) OVER()` é igual em TODA linha: é o total do filtro, não o da página. */
const withTotal = <R extends object>(total: number, rows: R[]): Array<R & { total_count: number }> => rows.map((r) => ({ ...r, total_count: total }));

describe('PatientsMapBodySchema (lex C1/C3/C4)', () => {
  it('country e escopo obrigatórios', () => {
    expect(PatientsMapBodySchema.safeParse({ center: CABA, radius_km: 5 }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR' }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', center: CABA }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', radius_km: 5 }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', state: 'Buenos Aires' }).success).toBe(true);
    expect(PatientsMapBodySchema.safeParse(SCOPE).success).toBe(true);
    expect(parse(SCOPE).limit).toBe(MAX_PATIENT_MAP_POINTS);
  });
  it('TRAVA C1: filtro clínico (ou qualquer chave desconhecida) é rejeitado', () => {
    for (const extra of ['clinical_specialty', 'dependency_level', 'attention_reason', 'needs_attention', 'service_type', 'diagnosis', 'search']) {
      expect(PatientsMapBodySchema.safeParse({ ...SCOPE, [extra]: 'x' }).success).toBe(false);
    }
  });
  it('status só aceita o enum de paciente; with_open_vacancies é boolean', () => {
    expect(PatientsMapBodySchema.safeParse({ ...SCOPE, status: ['foo'] }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ ...SCOPE, status: ['ACTIVE', 'SUSPENDED'] }).success).toBe(true);
    expect(PatientsMapBodySchema.safeParse({ ...SCOPE, with_open_vacancies: 'true' }).success).toBe(false);
  });
});

describe('buildPatientsMapQuery', () => {
  it('TRAVA DE PHI: o SQL não cita coluna clínica', () => {
    const { sql } = buildPatientsMapQuery(parse({ ...SCOPE, status: ['ACTIVE'], with_open_vacancies: true, state: 'x', city: 'y' }));
    expect(sql).not.toMatch(/diagnosis|additional_comments|dependency_level|clinical|emergency|medication|document_number|has_consent|attention/i);
  });

  it('escopo por localidade: país, deleted_at, endereços ativos, sem raio', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', state: 'Buenos Aires' }));
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(sql).toContain('p.country = $1');
    expect(sql).toContain('lower(btrim(pa.state)) = lower(btrim($2))');
    expect(sql).toContain('pa.archived_at IS NULL');
    expect(sql).not.toContain('AND p.status = ANY');
    expect(sql).not.toContain('ST_DWithin');
    expect(sql).toContain('NULL::numeric AS distance_km');
    expect(params).toEqual(['AR', 'Buenos Aires', MAX_PATIENT_MAP_POINTS]);
    expect(sql).toContain('LIMIT $3');
  });

  it('"vaga aberta" é a fonte única da lista de vagas (LIVE_JOB_POSTING_SQL), contada UMA vez num LATERAL', () => {
    const { sql } = buildPatientsMapQuery(parse({ ...SCOPE, with_open_vacancies: true }));
    expect(sql).toContain(LIVE_JOB_POSTING_SQL);
    expect(sql).toContain("'PENDING_ACTIVATION'");
    expect(sql).toContain('jp.is_draft = false');
    expect(sql.match(/COUNT\(\*\)::int AS open_vacancies/g)?.length).toBe(1);
    expect(sql.match(/FROM job_postings jp/g)?.length).toBe(1);
    expect(sql).toContain('ov.open_vacancies,');
    for (const st of OPEN_JOB_STATUSES) expect(sql).toContain(`'${st}'`);
  });

  it('a contagem sai do banco: COUNT(*) OVER() no SELECT, antes do LIMIT — e sem param novo', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', state: 'Buenos Aires' }));
    expect(sql).toContain('COUNT(*) OVER()::int AS total_count');
    expect(sql.indexOf('COUNT(*) OVER()')).toBeLessThan(sql.indexOf('FROM patients p'));
    expect(sql.indexOf('COUNT(*) OVER()')).toBeLessThan(sql.lastIndexOf('LIMIT $'));
    expect(params).toEqual(['AR', 'Buenos Aires', MAX_PATIENT_MAP_POINTS]);
  });

  it('status: lista vira ANY; lista vazia não filtra', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ ...SCOPE, status: ['ACTIVE', 'SUSPENDED'] }));
    expect(sql).toContain('AND p.status = ANY($2::text[])');
    expect(params[1]).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(buildPatientsMapQuery(parse({ ...SCOPE, status: [] })).sql).not.toContain('AND p.status = ANY');
  });

  it('city casa normalizado sobre patient_addresses', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', city: '  La Plata ' }));
    expect(sql).toContain('lower(btrim(pa.city)) = lower(btrim($2))');
    expect(params[1]).toBe('La Plata');
  });

  it('with_open_vacancies=true filtra por contagem > 0; false não filtra', () => {
    expect(buildPatientsMapQuery(parse({ ...SCOPE, with_open_vacancies: true })).sql).toContain('AND ov.open_vacancies > 0');
    expect(buildPatientsMapQuery(parse({ ...SCOPE, with_open_vacancies: false })).sql).not.toContain('ov.open_vacancies > 0');
  });

  it('centro + raio: ST_DWithin em metros sobre o ponto do endereço; sem coordenada NÃO é excluído; lng antes de lat', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', center: { lat: -34.6, lng: -58.4 }, radius_km: 10, limit: 7 }));
    expect(sql).toContain('(pa.lat IS NULL OR pa.lng IS NULL OR ST_DWithin(ST_SetSRID(ST_MakePoint(pa.lng, pa.lat), 4326)::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4))');
    expect(sql).toContain('ELSE ST_Distance(');
    expect(params).toEqual(['AR', -58.4, -34.6, 10000, 7]);
    expect(sql).toContain('LIMIT $5');
  });

  it('centro sem raio (escopo por state): distância sim, filtro de raio não', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', state: 'Buenos Aires', center: { lat: -34.6, lng: -58.4 } }));
    expect(sql).not.toContain('ST_DWithin');
    expect(sql).toContain('AS distance_km');
    expect(params).toEqual(['AR', 'Buenos Aires', -58.4, -34.6, MAX_PATIENT_MAP_POINTS]);
  });
});

describe('AdminPatientsMapController.getMapPoints', () => {
  let controller: AdminPatientsMapController;
  beforeEach(() => { jest.clearAllMocks(); controller = new AdminPatientsMapController(); });

  it('400 em corpo inválido / clínico / sem escopo / sem corpo, sem tocar no banco', async () => {
    for (const body of [undefined, {}, { country: 'AR' }, { ...SCOPE, clinical_specialty: 'ASD' }]) {
      const res = mockRes();
      await controller.getMapPoints(req(body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('200: um ponto por endereço; sem endereço vira lat/lng nulos; contagens; trilha sem PII', async () => {
    mockQuery.mockResolvedValueOnce({ rows: withTotal(4, [
      row(),
      row({ address_id: 'a2', address_type: 'secondary', lat: '-34.61', lng: '-58.39', distance_km: '0.5' }),
      row({ id: 'p2', first_name: null, last_name: null, address_id: null, address_type: null, lat: null, lng: null, city: null, neighborhood: null, state: null, open_vacancies: null }),
      // o driver pode entregar número (coluna double) em vez de string
      row({ id: 'p3', address_id: 'a3', lat: -34.62, lng: -58.4, open_vacancies: 1, distance_km: 3 }),
    ]) });
    const res = mockRes();
    await controller.getMapPoints(req({ ...SCOPE, limit: 4 }, 'uid-xyz'), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Array<Record<string, unknown>>; total: number; withoutCoordinates: number; truncated: boolean };
    expect(body.total).toBe(4);
    expect(body.withoutCoordinates).toBe(1);
    // 4 vieram e 4 existem: encheu o limit e mesmo assim NÃO está cortado.
    expect(body.truncated).toBe(false);
    expect(body.data[0]).toEqual({ id: 'p1', addressId: 'a1', name: 'Ana Paz', lat: -34.6, lng: -58.38, status: 'ACTIVE', addressType: 'primary', city: 'CABA', neighborhood: 'Flores', state: 'Buenos Aires', openVacancies: 2, distanceKm: null });
    expect(body.data[1]).toMatchObject({ addressId: 'a2', distanceKm: 0.5 });
    expect(body.data[2]).toEqual({ id: 'p2', addressId: null, name: '—', lat: null, lng: null, status: 'ACTIVE', addressType: null, city: null, neighborhood: null, state: null, openVacancies: 0, distanceKm: null });
    expect(body.data[3]).toMatchObject({ id: 'p3', lat: -34.62, lng: -58.4, openVacancies: 1, distanceKm: 3 });
    expect(JSON.stringify(body)).not.toMatch(/diagnos/i);
    const entry = mockLogInfo.mock.calls[0][0];
    // ALLOWLIST FECHADA: a lista é COMPLETA — chave a mais no log reprova aqui.
    // `profession` fica null: o mapa de pacientes não filtra por profissão, mas
    // a FORMA da linha é a mesma nas duas rotas (uma consulta de auditoria só).
    expect(entry).toEqual({
      msg: 'patients.map.read', uid: 'uid-xyz', country: 'AR', scope: 'radius',
      n: 4, withoutCoordinates: 1, truncated: false,
      totalMatching: 4, status: null, profession: null,
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false,
      radiusKm: 5, geohash5: '69y7p',
    });
    // o centro é a casa de um paciente (picker "Centrar en paciente"): vai a
    // CÉLULA de 5 caracteres, nunca a coordenada crua nem um identificador.
    expect((entry as { geohash5: string }).geohash5).toHaveLength(5);
    expect((entry as { geohash5: string }).geohash5).toBe(geohash5(CABA.lat, CABA.lng));
    expect(JSON.stringify(entry)).not.toContain(String(CABA.lat));
    expect(JSON.stringify(entry)).not.toContain(String(CABA.lng));
    expect(JSON.stringify(entry)).not.toMatch(/Ana|Paz|34\.6|58\.3|p1|a1|Flores/);
    for (const chave of ['id', 'patientId', 'addressId', 'name', 'lat', 'lng', 'center']) {
      expect(entry).not.toHaveProperty(chave);
    }
  });

  it('trilha com filtro de catálogo: status vai ao log; a localidade so como booleano; sem centro nao ha geocodigo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: withTotal(4231, [row()]) });
    const res = mockRes();
    await controller.getMapPoints(req({ country: 'AR', state: 'Buenos Aires', city: 'La Plata', status: ['ACTIVE', 'SUSPENDED'] }, 'uid-cat'), res);
    expect(res.statusCode).toBe(200);
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'patients.map.read', uid: 'uid-cat', country: 'AR', scope: 'location',
      n: 1, withoutCoordinates: 0, truncated: true,
      totalMatching: 4231, status: ['ACTIVE', 'SUSPENDED'], profession: null,
      stateCanonical: null, hasStateFilter: true, hasCityFilter: true,
      radiusKm: null, geohash5: null,
    });
  });

  it('REPROVA identificador na trilha: nenhum UUID de paciente/endereço entra no objeto logado', async () => {
    // C6: geohash + id de paciente seria endereço aproximado de IDENTIFICADO.
    const uuid = '9f1c2e30-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: uuid, address_id: uuid })] });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const entry = mockLogInfo.mock.calls[0][0] as Record<string, unknown>;
    expect((res.body as { data: Array<{ id: string }> }).data[0].id).toBe(uuid); // existe na RESPOSTA
    expect(JSON.stringify(entry)).not.toContain(uuid);                           // e não no LOG
    for (const chave of ['id', 'patientId', 'addressId', 'ids', 'data', 'points']) expect(entry).not.toHaveProperty(chave);
  });

  it('escopo por localidade sem req.user: trilha com uid null e scope location', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = mockRes();
    await controller.getMapPoints({ body: { country: 'BR', state: 'PR' } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'patients.map.read', uid: null, country: 'BR', scope: 'location',
      n: 0, withoutCoordinates: 0, truncated: false,
      // 'PR' não é apelido do conjunto fechado (só CABA/PBA são): a trilha diz
      // QUE houve recorte por província, não QUAL — texto livre não entra no log.
      totalMatching: 0, status: null, profession: null,
      stateCanonical: null, hasStateFilter: true, hasCityFilter: false,
      radiusKm: null, geohash5: null,
    });
  });

  it('teto 500: a lista corta, a CONTAGEM não — total vem do COUNT(*) OVER(), truncated marca o corte', async () => {
    // Mesmo defeito do mapa de prestadores: com `total = data.length` a tela
    // diria "500 en 25 km" havendo 4231 endereços no filtro.
    mockQuery.mockResolvedValueOnce({ rows: withTotal(4231, Array.from({ length: MAX_PATIENT_MAP_POINTS }, (_, k) => row({ id: `p${k}`, address_id: `a${k}` }))) });
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    const body = res.body as { data: unknown[]; total: number; truncated: boolean };
    expect(MAX_PATIENT_MAP_POINTS).toBe(500);
    expect(mockQuery.mock.calls[0][1].at(-1)).toBe(500); // o LIMIT que foi ao banco
    expect(mockQuery.mock.calls[0][0]).toContain('COUNT(*) OVER()::int AS total_count');
    expect(body.data).toHaveLength(500);
    expect(body.total).toBe(4231);
    expect(body.total).not.toBe(body.data.length);
    expect(body.truncated).toBe(true);
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'patients.map.read', uid: 'staff-1', country: 'AR', scope: 'radius',
      n: 500, withoutCoordinates: 0, truncated: true,
      // `totalMatching` é o tamanho REAL da varredura (4231), não o da tela (500).
      totalMatching: 4231, status: null, profession: null,
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false,
      radiusKm: 5, geohash5: '69y7p',
    });
  });

  it('500: log só com a origem', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const res = mockRes();
    await controller.getMapPoints(req({ ...SCOPE, city: 'Flores' }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to load patients map' });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminPatientsMapController:getMapPoints' });
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('500 com erro não-Error', async () => {
    mockQuery.mockRejectedValueOnce(42);
    const res = mockRes();
    await controller.getMapPoints(req(SCOPE), res);
    expect(res.statusCode).toBe(500);
    expect((mockReportError.mock.calls[0][0] as Error).message).toBe('42');
  });
});
