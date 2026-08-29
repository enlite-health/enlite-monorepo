/**
 * AdminPatientsController — createPatientAddress + listPatientAddresses.
 *
 * These two endpoints (POST/GET /api/admin/patients/:patientId/addresses)
 * had ZERO test coverage before this file. Covers:
 *   a. createPatientAddress: 400 invalid patientId, 400 invalid body,
 *      201 happy path (geocode succeeds), 201 with geocode returning null,
 *      201 when geocode THROWS (best-effort — never fails the request),
 *      displayOrder omitted → COALESCE default (null passed as $5), 500 on DB error.
 *   b. listPatientAddresses: 400 invalid patientId, 200 with rows, 500 on DB error.
 */

// ── Mocks (before importing the module under test) ────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockPoolQuery, connect: jest.fn() }),
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController.createPatientAddress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('400 quando patientId não é UUID (não chega no DB)', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: 'not-a-uuid' }, { address_formatted: 'Av. X 123' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid params' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('400 quando body não tem address_formatted', async () => {
    const controller = makeController();
    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, {});

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid body' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('201 happy path: geocode retorna lat/lng, INSERT recebe as coordenadas', async () => {
    const geocode = jest.fn().mockResolvedValue({ latitude: -34.6, longitude: -58.4 });
    const controller = makeController(geocode);
    const insertedRow = {
      id: 'addr-1', patient_id: PATIENT_ID, address_formatted: 'Av. X 123',
      address_raw: null, address_type: 'secondary',
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [insertedRow] });

    const [req, res] = mockReqRes(
      { patientId: PATIENT_ID },
      { address_formatted: 'Av. X 123', address_type: 'secondary', display_order: 2 },
    );

    await controller.createPatientAddress(req, res);

    expect(geocode).toHaveBeenCalledWith('Av. X 123');
    expect(res.status).toHaveBeenCalledWith(201);
    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: insertedRow });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO patient_addresses');
    expect(params).toEqual([PATIENT_ID, 'Av. X 123', null, 'secondary', 2, -34.6, -58.4]);
  });

  it('201: geocode retorna null (sem match) → lat/lng ficam null, request não falha', async () => {
    const geocode = jest.fn().mockResolvedValue(null);
    const controller = makeController(geocode);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'addr-2' }] });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Sin match 000' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });

  it('201: geocode lança exceção (best-effort) → lat/lng null, ainda 201', async () => {
    const geocode = jest.fn().mockRejectedValue(new Error('geocoding API down'));
    const controller = makeController(geocode);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'addr-3' }] });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Falha no geocode 456' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });

  it('display_order ausente → passa null pro COALESCE (default no SQL)', async () => {
    const controller = makeController();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'addr-4' }] });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Sem display order 789' });

    await controller.createPatientAddress(req, res);

    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[4]).toBeNull(); // display_order
  });

  it('address_type ausente usa o default "secondary" do schema', async () => {
    const controller = makeController();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'addr-5' }] });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Default type 000' });

    await controller.createPatientAddress(req, res);

    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[3]).toBe('secondary');
  });

  it('500 quando o INSERT lança exceção (valor não-Error → branch instanceof)', async () => {
    const controller = makeController();
    mockPoolQuery.mockRejectedValueOnce('constraint violation');

    const [req, res] = mockReqRes({ patientId: PATIENT_ID }, { address_formatted: 'Vai falhar 999' });

    await controller.createPatientAddress(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to create patient address',
      details: 'constraint violation',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      { source: 'AdminPatientsController:createPatientAddress' },
    );
  });

  it('500 quando o INSERT rejeita com uma instância de Error (branch instanceof=true)', async () => {
    const controller = makeController();
    mockPoolQuery.mockRejectedValueOnce(new Error('constraint violation (Error instance)'));

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

  it('200 com a lista de endereços ativos do paciente', async () => {
    const controller = makeController();
    const rows = [
      { id: 'a1', address_formatted: 'Calle 1', address_raw: null, address_type: 'primary', display_order: 1, source: 'admin_manual', complement: null, lat: '-34.6', lng: '-58.4' },
    ];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const [req, res] = mockReqRes({ patientId: PATIENT_ID });
    await controller.listPatientAddresses(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: rows });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('FROM patient_addresses');
    expect(sql).toContain('archived_at IS NULL');
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
