jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { AdminPatientImageConsentController } from '../AdminPatientImageConsentController';
import { AuthMiddleware } from '@modules/identity';
import {
  ImageConsentAlreadyActiveError,
  RepresentativeRequiredError,
  ImageConsentReferenceNotFoundError,
} from '../../../application/RegisterImageConsentUseCase';
import type { Response } from 'express';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}
const db = (exists = true) => ({ query: jest.fn().mockResolvedValue({ rows: exists ? [{ x: 1 }] : [] }) });
const VALID_BODY = { consenterKind: 'PATIENT', textVersion: 'v1', consentedAt: '2026-09-14T10:00:00Z' };

describe('AdminPatientImageConsentController (D335 — registrar é opcional)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('register', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientImageConsentController({ execute: jest.fn() } as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido', async () => {
      const c = new AdminPatientImageConsentController({ execute: jest.fn() } as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientImageConsentController({ execute: jest.fn() } as never, {} as never, db(false) as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('201 feliz', async () => {
      const register = { execute: jest.fn(async () => ({ id: CID })) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(register.execute).toHaveBeenCalledWith(PID, VALID_BODY, 'uid-1');
    });

    it('409 ImageConsentAlreadyActiveError', async () => {
      const register = { execute: jest.fn(async () => { throw new ImageConsentAlreadyActiveError(); }) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('422 RepresentativeRequiredError', async () => {
      const register = { execute: jest.fn(async () => { throw new RepresentativeRequiredError(); }) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('404 ImageConsentReferenceNotFoundError', async () => {
      const register = { execute: jest.fn(async () => { throw new ImageConsentReferenceNotFoundError(); }) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('500 erro inesperado', async () => {
      const register = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const register = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
      const res = mockRes();
      await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('revoke', () => {
    const REVOKE_BODY = { revocationChannel: 'EMAIL' };

    it('400 params inválidos', async () => {
      const c = new AdminPatientImageConsentController({} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido', async () => {
      const c = new AdminPatientImageConsentController({} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientImageConsentController({} as never, { execute: jest.fn() } as never, db(false) as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: REVOKE_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 consentimento não encontrado', async () => {
      const revoke = { execute: jest.fn(async () => ({ revoked: false })) };
      const c = new AdminPatientImageConsentController({} as never, revoke as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: REVOKE_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 feliz — apaga a foto na mesma operação (comportamento do use case)', async () => {
      const revoke = { execute: jest.fn(async () => ({ revoked: true })) };
      const c = new AdminPatientImageConsentController({} as never, revoke as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: REVOKE_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(revoke.execute).toHaveBeenCalledWith(PID, CID, REVOKE_BODY, 'uid-1');
    });

    it('500 erro inesperado', async () => {
      const revoke = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientImageConsentController({} as never, revoke as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: REVOKE_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const revoke = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientImageConsentController({} as never, revoke as never, db() as never);
      const res = mockRes();
      await c.revoke(mockReq({ params: { id: PID, cid: CID }, body: REVOKE_BODY }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  it('actorUid sem ator identificado lança (lex C6)', async () => {
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const register = { execute: jest.fn() };
    const c = new AdminPatientImageConsentController(register as never, {} as never, db() as never);
    const res = mockRes();
    await c.register(mockReq({ params: { id: PID }, body: VALID_BODY }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new AdminPatientImageConsentController();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });
});
