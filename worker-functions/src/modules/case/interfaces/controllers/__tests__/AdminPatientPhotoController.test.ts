jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { AdminPatientPhotoController } from '../AdminPatientPhotoController';
import { AuthMiddleware } from '@modules/identity';
import { InvalidPatientPhotoError, PatientPhotoTooLargeError } from '../../../infrastructure/PatientPhotoProcessor';
import type { Response } from 'express';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock; send: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock; send: jest.Mock } = { status: jest.fn(), json: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock; send: jest.Mock };
}
const db = (exists = true) => ({ query: jest.fn().mockResolvedValue({ rows: exists ? [{ x: 1 }] : [] }) });

describe('AdminPatientPhotoController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('upload', () => {
    it('400 params inválidos', async () => {
      const upload = { execute: jest.fn() };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 sem file', async () => {
      const upload = { execute: jest.fn() };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(upload.execute).not.toHaveBeenCalled();
    });

    it('415 content-type não aceito', async () => {
      const upload = { execute: jest.fn() };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(415);
    });

    it('404 paciente não existe', async () => {
      const upload = { execute: jest.fn() };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db(false) as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('201 feliz', async () => {
      const upload = { execute: jest.fn(async () => ({ hasPhoto: true })) };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(upload.execute).toHaveBeenCalledWith({ patientId: PID, buffer: Buffer.from('x'), actorUid: 'uid-1' });
    });

    it('413 PatientPhotoTooLargeError', async () => {
      const upload = { execute: jest.fn(async () => { throw new PatientPhotoTooLargeError(); }) };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(413);
    });

    it('422 InvalidPatientPhotoError', async () => {
      const upload = { execute: jest.fn(async () => { throw new InvalidPatientPhotoError('x'); }) };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('500 erro inesperado', async () => {
      const upload = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado (branch String(err))', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal -- prova deliberada do branch
      const upload = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('remove', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientPhotoController({} as never, { execute: jest.fn() } as never, {} as never, db() as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientPhotoController({} as never, { execute: jest.fn() } as never, {} as never, db(false) as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 sem foto', async () => {
      const del = { execute: jest.fn(async () => ({ deleted: false })) };
      const c = new AdminPatientPhotoController({} as never, del as never, {} as never, db() as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('204 feliz', async () => {
      const del = { execute: jest.fn(async () => ({ deleted: true })) };
      const c = new AdminPatientPhotoController({} as never, del as never, {} as never, db() as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('500 erro inesperado', async () => {
      const del = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientPhotoController({} as never, del as never, {} as never, db() as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const del = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientPhotoController({} as never, del as never, {} as never, db() as never);
      const res = mockRes();
      await c.remove(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getUrl', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientPhotoController({} as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientPhotoController({} as never, {} as never, { execute: jest.fn() } as never, db(false) as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 sem foto', async () => {
      const getUrl = { execute: jest.fn(async () => null) };
      const c = new AdminPatientPhotoController({} as never, {} as never, getUrl as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 feliz', async () => {
      const getUrl = { execute: jest.fn(async () => ({ url: 'https://x', expiresInSeconds: 300 })) };
      const c = new AdminPatientPhotoController({} as never, {} as never, getUrl as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('500 erro inesperado', async () => {
      const getUrl = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientPhotoController({} as never, {} as never, getUrl as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const getUrl = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientPhotoController({} as never, {} as never, getUrl as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  it('constrói pelos DEFAULTS do construtor (caminho de produção)', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new AdminPatientPhotoController();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('actorUid sem ator identificado lança (lex C6)', async () => {
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const upload = { execute: jest.fn() };
    const c = new AdminPatientPhotoController(upload as never, {} as never, {} as never, db() as never);
    const res = mockRes();
    await c.upload(mockReq({ params: { id: PID }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
