/**
 * AdminPatientsController — createPatientAddress + listPatientAddresses.
 *
 * Spec 019 (D310 item c): `address_type` sai do schema de criação — só `is_default` (opcional)
 * entra. `insertPatientAddress` passa a usar `db.connect()` (transação: troca atômica do
 * principal / regra de nascimento) em vez de `db.query()` direto — os mocks abaixo espelham isso.
 *
 * Covers:
 *   a. createPatientAddress: 400 invalid patientId, 400 invalid body,
 *      201 happy path (geocode succeeds), 201 with geocode returning null,
 *      201 when geocode THROWS (best-effort — never fails the request),
 *      displayOrder omitido → COALESCE default (null passado no INSERT),
 *      is_default omitido → regra de nascimento (SELECT EXISTS decide),
 *      is_default explícito true → demove o principal anterior na mesma transação,
 *      500 on DB error (ROLLBACK).
 *   b. listPatientAddresses: 400 invalid patientId, 200 com rows (inclui is_default), 500 on DB error.
 */

// ── Mocks (before importing the module under test) ────────────────────────────

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockClientRelease }));

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockPoolQuery, connect: mockConnect }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('enc'),
    decrypt: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    findDetailById: jest.fn(),
    list: jest.fn(),
    stats: jest.fn(),
  })),
}));

jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(),
  buildInsertParams: jest.fn(),
}));

import { reportError } from '@shared/logging';
import { AdminPatientsController } from '../AdminPatientsController';
import { Request, Response } from 'express';

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockReqRes(
  params: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): [Request, Response] {
  const req = { params, query: {}, body } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';

function makeController(geocode?: jest.Mock): AdminPatientsController {
  const geocoder = { geocode: geocode ?? jest.fn().mockResolvedValue(null) } as unknown as import('../../../../../infrastructure/services/GeocodingService').GeocodingService;
  return new AdminPatientsController(geocoder);
}

/** Configura o client de transação: BEGIN → (opcional demote) → (opcional SELECT EXISTS) → INSERT → COMMIT. */
function queueClientHappyPath(opts: { hasExistingDefault?: boolean; insertedRow: Record<string, unknown> }) {
  mockClientQuery.mockReset();
  mockClientQuery
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce({ rows: [{ exists: opts.hasExistingDefault ?? false }] }) // SELECT EXISTS
    .mockResolvedValueOnce({ rows: [opts.insertedRow] }) // INSERT
    .mockResolvedValueOnce(undefined); // COMMIT
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController.createPatientAddress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockImplementation(() => Promise.resolve({ query: mockClientQuery, release: mockClientRelease }));
  });

  it('400 quando patientId não é UUID (não chega no DB)', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: 'not-a-uuid' }, { address_formatted: 'Av. X 123' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid params' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('400 quando body não tem address_formatted', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, {});

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid body' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('address_type no body é ignorado pelo zod (campo removido do schema na spec 019) e nunca chega ao INSERT', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Av. X 123', address_type: 'primary' });

    // zod não é .strict() aqui, então um campo desconhecido é IGNORADO (não gera 400) — o que
    // importa é que ele nunca chega ao INSERT. Prova via 201 + params sem 'primary'.
    queueClientHappyPath({ insertedRow: { id: 'addr-1', patient_id: PATIENT_ID, address_formatted: 'Av. X 123', address_raw: null, is_default: true } });
    await controller.createPatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const insertCall = mockClientQuery.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_addresses'));
    expect(insertCall![0]).not.toMatch(/address_type/);
  });

  it('201 happy path: geocode retorna lat/lng, sem principal ativo → nasce is_default=true (regra de nascimento)', async () => {
    const geocode = jest.fn().mockResolvedValue({ latitude: -34.6, longitude: -58.4 });
    const controller = makeController(geocode);
    const insertedRow = {
      id: 'addr-1', patient_id: PATIENT_ID, address_formatted: 'Av. X 123',
      address_raw: null, is_default: true,
    };
    queueClientHappyPath({ hasExistingDefault: false, insertedRow });

    const [req, res] = mockReqRes(
      { patientId: PATIENT_ID },
      { address_formatted: 'Av. X 123', display_order: 2 },
    );

    await controller.createPatientAddress(req, res);

    expect(geocode).toHaveBeenCalledWith('Av. X 123');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: insertedRow });

    const insertCall = mockClientQuery.mock.calls[2];
    const [sql, params] = insertCall;
    expect(sql).toContain('INSERT INTO patient_addresses');
    expect(params).toEqual([PATIENT_ID, 'Av. X 123', null, 2, -34.6, -58.4, null, null, null, true]);
    expect(sql).toMatch(/\(SELECT country FROM patients WHERE id = \$1\)/);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('201: paciente JÁ tem principal ativo e is_default omitido → nasce false', async () => {
    const controller = makeController();
    queueClientHappyPath({ hasExistingDefault: true, insertedRow: { id: 'addr-2', is_default: false } });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Sin match 000' });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const [, params] = mockClientQuery.mock.calls[2];
    expect(params[9]).toBe(false);
  });

  it('201: is_default=true explícito → desmarca o principal anterior NA MESMA TRANSAÇÃO antes do INSERT', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // UPDATE demote (is_default explícito, sem SELECT EXISTS)
      .mockResolvedValueOnce({ rows: [{ id: 'addr-3', is_default: true }] }) // INSERT
      .mockResolvedValueOnce(undefined); // COMMIT

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Nova principal', is_default: true });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const demoteCall = mockClientQuery.mock.calls[1];
    expect(demoteCall[0]).toMatch(/UPDATE patient_addresses SET is_default = false/);
    expect(demoteCall[1]).toEqual([PATIENT_ID]);
    const [, insertParams] = mockClientQuery.mock.calls[2];
    expect(insertParams[9]).toBe(true);
  });

  it('201: is_default=false explícito → nasce false sem consultar EXISTS nem demover ninguém', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'addr-4', is_default: false }] }) // INSERT direto
      .mockResolvedValueOnce(undefined); // COMMIT

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Secundario', is_default: false });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockClientQuery).toHaveBeenCalledTimes(3); // BEGIN, INSERT, COMMIT — sem EXISTS nem demote
    const [, params] = mockClientQuery.mock.calls[1];
    expect(params[9]).toBe(false);
  });

  it('201: geocode retorna null (sem match) → lat/lng ficam null, request não falha', async () => {
    const geocode = jest.fn().mockResolvedValue(null);
    const controller = makeController(geocode);
    queueClientHappyPath({ insertedRow: { id: 'addr-5' } });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Sin match 000' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const [, params] = mockClientQuery.mock.calls[2];
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it('201: geocode lança exceção (best-effort) → lat/lng null, ainda 201', async () => {
    const geocode = jest.fn().mockRejectedValue(new Error('geocoding API down'));
    const controller = makeController(geocode);
    queueClientHappyPath({ insertedRow: { id: 'addr-6' } });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Falha no geocode 456' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const [, params] = mockClientQuery.mock.calls[2];
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it('display_order ausente → passa null pro COALESCE (default no SQL)', async () => {
    const controller = makeController();
    queueClientHappyPath({ insertedRow: { id: 'addr-7' } });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Sem display order 789' });

    await controller.createPatientAddress(req, res);

    const [, params] = mockClientQuery.mock.calls[2];
    expect(params[3]).toBeNull(); // display_order
  });

  it('500 quando o INSERT lança exceção → ROLLBACK e release, resposta genérica', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // SELECT EXISTS
      .mockRejectedValueOnce('constraint violation') // INSERT falha
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Vai falhar 999' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    // lex C2.3 (spec 012): a resposta NÃO ecoa o erro do banco (pode carregar a linha inteira).
    expect((res as any).json.mock.calls[0][0]).toEqual({
      success: false,
      error: 'Failed to create patient address',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      { source: 'AdminPatientsController:createPatientAddress', patientId: PATIENT_ID },
    );
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('500 quando o INSERT E o ROLLBACK falham (duplo erro) — a exceção original ainda sobe, release chamado', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // SELECT EXISTS
      .mockRejectedValueOnce(new Error('insert falhou')) // INSERT
      .mockRejectedValueOnce(new Error('rollback também falhou')); // ROLLBACK

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Duplo erro' });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledWith(
      new Error('insert falhou'),
      { source: 'AdminPatientsController:createPatientAddress', patientId: PATIENT_ID },
    );
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('409 (K5, spec 019): unique_violation no índice parcial (dois POSTs concorrentes sem principal) — tratado, não 500', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // SELECT EXISTS (nenhum principal ainda visto)
      .mockRejectedValueOnce(Object.assign(
        new Error('duplicate key value violates unique constraint "patient_addresses_one_default_per_patient"'),
        { code: '23505' },
      )) // INSERT perde a corrida
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Concorrente 111' });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res as any).json.mock.calls[0][0]).toEqual({ success: false, error: 'Concurrent update — try again' });
    expect(reportError).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('500 quando o INSERT rejeita com uma instância de Error (branch instanceof=true)', async () => {
    const controller = makeController();
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockRejectedValueOnce(new Error('constraint violation (Error instance)'))
      .mockResolvedValueOnce(undefined);

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Vai falhar 999' });
    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('AdminPatientsController.listPatientAddresses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('400 quando patientId não é UUID', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: 'not-a-uuid' });

    await controller.listPatientAddresses(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('200 com a lista de endereços ativos do paciente, incluindo is_default', async () => {
    const controller = makeController();
    const rows = [
      { id: 'a1', address_formatted: 'Calle 1', address_raw: null, address_type: null, is_default: true, display_order: 1, source: 'admin_manual', complement: null, lat: '-34.6', lng: '-58.4' },
    ];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID });
    await controller.listPatientAddresses(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: rows });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('FROM patient_addresses');
    expect(sql).toContain('archived_at IS NULL');
    expect(sql).toContain('is_default');
    expect(params).toEqual([PATIENT_ID]);
  });

  it('200 com array vazio quando o paciente não tem endereços', async () => {
    const controller = makeController();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID });
    await controller.listPatientAddresses(req, res);

    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  it('500 quando o SELECT lança exceção (valor não-Error → branch instanceof)', async () => {
    const controller = makeController();
    mockPoolQuery.mockRejectedValueOnce('connection reset');

    const [req, res] = mockReqRes({ patientId: PATIENT_ID });
    await controller.listPatientAddresses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to list patient addresses',
      details: 'connection reset',
    });
  });

  it('500 quando o SELECT rejeita com uma instância de Error (branch instanceof=true)', async () => {
    const controller = makeController();
    mockPoolQuery.mockRejectedValueOnce(new Error('connection reset (Error instance)'));

    const [req, res] = mockReqRes({ patientId: PATIENT_ID });
    await controller.listPatientAddresses(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
