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
  MAX_NAME_SCOPE_POINTS,
} from '../AdminPatientsMapController';
import { LIVE_JOB_POSTING_SQL, OPEN_JOB_STATUSES } from '@modules/matching/domain/openJobStatuses';
import { geohash5 } from '@shared/utils/geohash';
import { NAMED_READ_AUDIT_MAX } from '@shared/http/mapQueryCommon';

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

describe('AdminPatientsMapController.getMapPoints — nome do pino por patient_identity:read (D286 fase 2)', () => {
  it('sem a célula de identidade o pino diz NOME_REDIGIDO e mantém a coordenada; com ela, o nome', async () => {
    const controller = new AdminPatientsMapController();
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: 'p1' })] });
    const res = mockRes();
    await controller.getMapPoints({ ...req(SCOPE), permissionCells: ['patient_address:read'] } as unknown as Request, res);
    const semIdentidade = (res.body as { data: Array<{ name: string; lat: number | null }> }).data[0];
    expect(semIdentidade.name).toBe('Contato restrito');
    expect(semIdentidade.lat).not.toBeNull();

    mockQuery.mockResolvedValueOnce({ rows: [row({ id: 'p1' })] });
    const res2 = mockRes();
    await controller.getMapPoints({ ...req(SCOPE), permissionCells: ['patient_address:read', 'patient_identity:read'] } as unknown as Request, res2);
    expect((res2.body as { data: Array<{ name: string }> }).data[0].name).not.toBe('Contato restrito');
  });

  // Gate do sync main→stage (08/09): busca (main) × redação (stage) — sem a célula de identidade,
  // filtrar por nome seria um oráculo ("existe alguém chamado X, e mora aqui").
  it('🔴 `search` SEM patient_identity:read → 403 nomeando o campo, e o banco NÃO é consultado', async () => {
    jest.clearAllMocks();
    const controller = new AdminPatientsMapController();
    const res = mockRes();
    await controller.getMapPoints(
      { ...req({ country: 'AR', search: 'reyna' }), permissionCells: ['patient_address:read'] } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden', details: { field: 'search' } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('`search` COM patient_identity:read → 200 e o nome sai em claro', async () => {
    const controller = new AdminPatientsMapController();
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: 'p1' })] });
    const res = mockRes();
    await controller.getMapPoints(
      { ...req({ country: 'AR', search: 'reyna' }), permissionCells: ['patient_address:read', 'patient_identity:read'] } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: Array<{ name: string }> }).data[0].name).not.toBe('Contato restrito');
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
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false, hasSearchFilter: false,
      resultIds: null,
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
      stateCanonical: null, hasStateFilter: true, hasCityFilter: true, hasSearchFilter: false,
      resultIds: null,
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
      stateCanonical: null, hasStateFilter: true, hasCityFilter: false, hasSearchFilter: false,
      resultIds: null,
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
      stateCanonical: null, hasStateFilter: false, hasCityFilter: false, hasSearchFilter: false,
      resultIds: null,
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

/**
 * Busca por NOME — a terceira forma de escopo (07/09/2026).
 *
 * O seletor da âncora do mapa só enxergava 50 km do centro do país e filtrava
 * em memória: paciente de Mar del Plata (381 km) não estava na lista e a tela
 * respondia "Sin resultados". Estes testes travam as três coisas que fazem a
 * busca ser segura além de funcionar: ela VALE como escopo sozinha, ela EXIGE
 * 2 caracteres, e o termo — que é nome de pessoa — NUNCA entra na trilha.
 */
describe('busca por nome (escopo alternativo)', () => {
  it('`search` sozinho é escopo válido: sem centro, sem raio, sem província', () => {
    const r = PatientsMapBodySchema.safeParse({ country: 'AR', search: 'Reyna' });
    expect(r.success).toBe(true);
  });

  it('1 caractere é 400: escopo que devolve a base inteira não é escopo', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'R' }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: '  ' }).success).toBe(false);
  });

  it('país continua obrigatório mesmo buscando por nome', () => {
    expect(PatientsMapBodySchema.safeParse({ search: 'Reyna' }).success).toBe(false);
  });

  it('casa NOME COMPLETO nas duas ordens, com UM só parâmetro', () => {
    const { sql, params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Reyna Alaburda' }));
    // as duas ordens continuam lá — agora dentro da dobra de acento
    expect(sql).toContain("concat_ws(' ', p.first_name, p.last_name)");
    expect(sql).toContain("concat_ws(' ', p.last_name, p.first_name)");
    expect(sql.match(/ILIKE '%' \|\| \$\d+ \|\| '%'/g) ?? []).toHaveLength(2);
    // o termo entra uma vez só na lista de params, referenciado duas vezes no SQL
    expect(params.filter((p) => p === 'Reyna Alaburda')).toHaveLength(1);
  });

  it('sem centro não há distância: o ORDER BY cai para o nome, e distance_km é nulo', () => {
    const { sql } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Reyna' }));
    expect(sql).toContain('NULL::numeric AS distance_km');
    expect(sql).not.toContain('ST_DWithin');
  });

  it('continua sem coluna clínica — a busca não abriu porta nova (lex C1)', () => {
    const { sql } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Reyna' }));
    for (const proibida of ['diagnosis', 'additional_comments', 'dependency_level', 'clinical_specialty']) {
      expect(sql).not.toContain(proibida);
    }
  });

  it('filtro clínico junto da busca continua 400 (strict)', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'Reyna', dependency_level: 'HIGH' }).success).toBe(false);
  });

  it('🔒 a trilha diz QUE se buscou, NUNCA por quem', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    const res = mockRes();
    await new AdminPatientsMapController().getMapPoints(
      req(parse({ country: 'AR', search: 'Reyna Alaburda' })), res,
    );
    expect(res.statusCode).toBe(200);
    const logged = mockLogInfo.mock.calls[0][0] as Record<string, unknown>;
    expect(logged.hasSearchFilter).toBe(true);
    expect(logged).not.toHaveProperty('search');
    // nenhum VALOR do termo em lugar nenhum da linha logada
    expect(JSON.stringify(logged).toLowerCase()).not.toContain('reyna');
    expect(JSON.stringify(logged).toLowerCase()).not.toContain('alaburda');
  });

  it('🔒 a trilha diz `scope: name` — não "location", que significa recorte por localidade', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    await new AdminPatientsMapController().getMapPoints(
      req(parse({ country: 'AR', search: 'Reyna' })), mockRes(),
    );
    expect((mockLogInfo.mock.calls[0][0] as Record<string, unknown>).scope).toBe('name');
  });

  it('centro+raio continua `radius`, e província continua `location`', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    await new AdminPatientsMapController().getMapPoints(req(parse(SCOPE)), mockRes());
    expect((mockLogInfo.mock.calls[0][0] as Record<string, unknown>).scope).toBe('radius');

    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    await new AdminPatientsMapController().getMapPoints(
      req(parse({ country: 'AR', state: 'Buenos Aires' })), mockRes(),
    );
    expect((mockLogInfo.mock.calls[0][0] as Record<string, unknown>).scope).toBe('location');
  });

  it('sem busca, o booleano é false (a allowlist não muda de forma)', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    await new AdminPatientsMapController().getMapPoints(req(parse(SCOPE)), mockRes());
    expect((mockLogInfo.mock.calls[0][0] as Record<string, unknown>).hasSearchFilter).toBe(false);
  });
});

/**
 * 🔒 O CURINGA — o achado que bloqueou este PR no gate (07/09/2026).
 *
 * `search` sozinho satisfaz a exigência de escopo. Sem escape, `%` e `_` fazem
 * o TERMO decidir quantas linhas voltam: `{country:'AR', search:'%%'}` passava
 * o mínimo de 2 caracteres e devolvia a base inteira — nome, bairro e
 * COORDENADA DE DOMICÍLIO de 500 pacientes — com o log dizendo apenas
 * "hasSearchFilter: true". É o "sem escopo é export da base" entrando pela
 * porta que a própria busca abriu.
 *
 * Duas camadas, e cada uma tem teste próprio: a borda recusa o termo que é só
 * curinga; o SQL escapa o valor e fecha com `ESCAPE`.
 */
describe('busca por nome — curinga não vira export da base', () => {
  it('🔒 `%%` é 400, não a base inteira', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: '%%' }).success).toBe(false);
  });

  it('🔒 `__` também — casa um caractere cada, varre igual', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: '__' }).success).toBe(false);
  });

  it('🔒 barra dupla e curinga com espaço não passam', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: '\\\\' }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: '% %' }).success).toBe(false);
  });

  it('nome de verdade continua passando', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'Reyna' }).success).toBe(true);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'Peña' }).success).toBe(true);
  });

  it('🔒 o valor vai ESCAPADO ao banco — curinga no meio do nome vira literal', () => {
    const { params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Ana%Paz' }));
    expect(params).toContain('Ana\\%Paz');
    expect(params).not.toContain('Ana%Paz');
  });

  it('🔒 as DUAS cláusulas fecham com ESCAPE — sem ela o escape do valor é inerte', () => {
    const { sql } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Reyna' }));
    const comEscape = sql.match(/ILIKE '%' \|\| \$\d+ \|\| '%' ESCAPE '\\'/g) ?? [];
    expect(comEscape).toHaveLength(2);
  });

  it('a busca comum não é afetada pelo escape', () => {
    const { params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Reyna Alaburda' }));
    expect(params).toContain('Reyna Alaburda');
  });
});

/**
 * 🔒 ACENTO — quem procura "Peña" digita "Pena".
 *
 * O filtro em memória que a busca no servidor substituiu normalizava acento
 * (NFD no cliente); o `ILIKE` cru não. Era regressão, num mercado de Peña,
 * García e Muñoz. Termo e coluna passam pela MESMA tabela de dobra.
 */
describe('busca por nome — acento dobrado dos dois lados', () => {
  it('🔒 a COLUNA é dobrada nas duas ordens do nome', () => {
    const { sql } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Pena' }));
    const dobras = sql.match(/translate\(concat_ws/g) ?? [];
    expect(dobras).toHaveLength(2);
  });

  it('🔒 o TERMO também é dobrado — dobrar só um lado falha só nos nomes acentuados', () => {
    const { params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Peña' }));
    expect(params).toContain('Pena');
    expect(params).not.toContain('Peña');
  });

  it('dobra e escape convivem: curinga escapado E acento dobrado no mesmo termo', () => {
    const { params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'Pe%ña' }));
    expect(params).toContain('Pe\\%na');
  });
});

/**
 * 🔒 As condições do parecer do `lex` de 07/09/2026 sobre a busca por nome.
 *
 * O conserto do curinga fechou o `%%` SINTÁTICO e deixou o SEMÂNTICO aberto:
 * com mínimo de 2, termos legítimos varriam a base. Medido em produção, só
 * contagem: 'an' → 266 linhas (38%), 'ar' → 241 (35%), 'el' → 209 (30%).
 * Com 3 o pior caso é 'mar' → 110 (16%), e o teto próprio corta o resto.
 */
describe('escopo por nome — proporcionalidade (lex C-A e C-B)', () => {
  it('🔒 dois caracteres agora é 400 — `an` devolvia 38% da base', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'an' }).success).toBe(false);
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'ar' }).success).toBe(false);
  });

  it('três caracteres passa — é o piso medido, não um número escolhido', () => {
    expect(PatientsMapBodySchema.safeParse({ country: 'AR', search: 'ana' }).success).toBe(true);
  });

  it('🔒 o escopo por NOME tem teto próprio, menor que o geográfico', () => {
    const porNome = buildPatientsMapQuery(parse({ country: 'AR', search: 'mar' }));
    expect(porNome.params.at(-1)).toBe(MAX_NAME_SCOPE_POINTS);
    expect(MAX_NAME_SCOPE_POINTS).toBeLessThan(MAX_PATIENT_MAP_POINTS);
  });

  it('🔒 o escopo GEOGRÁFICO continua com 500 — o teto novo não vazou para ele', () => {
    const porRaio = buildPatientsMapQuery(parse(SCOPE));
    expect(porRaio.params.at(-1)).toBe(MAX_PATIENT_MAP_POINTS);
  });

  it('o teto é máximo, não piso: `limit` menor no corpo continua valendo', () => {
    const { params } = buildPatientsMapQuery(parse({ country: 'AR', search: 'mar', limit: 10 }));
    expect(params.at(-1)).toBe(10);
  });

  it('a CONTAGEM não é cortada pelo teto — a tela ainda diz "há mais, refiná"', () => {
    const { sql } = buildPatientsMapQuery(parse({ country: 'AR', search: 'mar' }));
    expect(sql).toContain('COUNT(*) OVER()::int AS total_count');
  });
});

/**
 * 🔒 ALLOWLIST FECHADA para `scope: 'name'` (lex C-E).
 *
 * Ela existia só para `scope:'radius'`. Sem esta, uma chave nova na linha de
 * uma leitura NOMINAL entraria sem reprovar nada — e é justamente a linha em
 * que um identificador não pode aparecer sem decisão escrita.
 */
describe('trilha da leitura NOMINAL — allowlist fechada', () => {
  it('🔒 a linha tem EXATAMENTE estes campos, e nenhum identifica quem foi lido', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(3, [row(), row({ id: 'p2' }), row({ id: 'p3' })]) });
    await new AdminPatientsMapController().getMapPoints(
      req(parse({ country: 'AR', search: 'Reyna Alaburda' })), mockRes(),
    );
    expect(mockLogInfo.mock.calls[0][0]).toEqual({
      msg: 'patients.map.read',
      uid: 'staff-1',
      country: 'AR',
      scope: 'name',
      n: 3,
      withoutCoordinates: 0,
      truncated: false,
      totalMatching: 3,
      status: null,
      profession: null,
      stateCanonical: null,
      hasStateFilter: false,
      hasCityFilter: false,
      hasSearchFilter: true,
      radiusKm: null,
      geohash5: null,
      resultIds: ['p1', 'p2', 'p3'],
    });
  });

  it('🔒 nem o termo, nem nome, nem coordenada — o UUID é o ÚNICO identificador, e é deliberado', async () => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(1, [row()]) });
    await new AdminPatientsMapController().getMapPoints(
      req(parse({ country: 'AR', search: 'Reyna Alaburda' })), mockRes(),
    );
    const linha = JSON.stringify(mockLogInfo.mock.calls[0][0]);
    // o termo buscado, o nome de quem foi lido e a coordenada continuam FORA
    for (const proibido of ['Reyna', 'Alaburda', 'Ana', 'Paz', 'a1', '-34.60', '-58.38']) {
      expect(linha).not.toContain(proibido);
    }
    // o UUID entra, e só ele — é a decisão do Gabriel de 07/09 (lex C-E, opção a)
    expect((mockLogInfo.mock.calls[0][0] as Record<string, unknown>).resultIds).toEqual(['p1']);
  });
});

/**
 * 🔒 Trilha da leitura DIRIGIDA (lex C-E, opção (a) — decidida em 07/09/2026).
 */
describe('trilha da leitura dirigida — QUEM, quando foram poucos', () => {
  const chamar = async (body: Record<string, unknown>, rows: unknown[], total: number) => {
    mockLogInfo.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: withTotal(total, rows as never[]) });
    await new AdminPatientsMapController().getMapPoints(req(parse(body)), mockRes());
    return mockLogInfo.mock.calls[0][0] as Record<string, unknown>;
  };

  it('🔒 busca por nome com POUCOS resultados registra os UUID', async () => {
    const l = await chamar({ country: 'AR', search: 'Reyna' }, [row(), row({ id: 'p2' })], 2);
    expect(l.resultIds).toEqual(['p1', 'p2']);
  });

  it('🔒 e NUNCA o nome — só o identificador', async () => {
    const l = await chamar({ country: 'AR', search: 'Reyna' }, [row()], 1);
    expect(JSON.stringify(l)).not.toContain('Ana');
    expect(JSON.stringify(l)).not.toContain('Paz');
    expect(JSON.stringify(l)).not.toContain('Reyna');
  });

  it('acima do teto volta a ser só contagem — 50 UUID não respondem nada', async () => {
    const muitos = Array.from({ length: NAMED_READ_AUDIT_MAX + 1 }, (_, i) => row({ id: `p${i}` }));
    const l = await chamar({ country: 'AR', search: 'mar' }, muitos, 6);
    expect(l.resultIds).toBeNull();
  });

  it('🔒 escopo GEOGRÁFICO nunca registra ids — ali há geohash5 na linha', async () => {
    const l = await chamar(SCOPE, [row()], 1);
    expect(l.resultIds).toBeNull();
    expect(l.geohash5).not.toBeNull();
  });

  it('🔒 o par proibido não se forma: onde há resultIds, geohash5 é null', async () => {
    const l = await chamar({ country: 'AR', search: 'Reyna' }, [row()], 1);
    expect(l.resultIds).not.toBeNull();
    expect(l.geohash5).toBeNull();
    expect(l.radiusKm).toBeNull();
  });
});
