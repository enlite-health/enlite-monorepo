jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { AdminPatientDocumentController } from '../AdminPatientDocumentController';
import { AuthMiddleware } from '@modules/identity';
import { PatientDocumentTooLargeError } from '../../../application/UploadPatientDocumentUseCase';
import { InvalidDocumentImageError } from '../../../infrastructure/stripJpegMetadata';
import type { Response } from 'express';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

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

describe('AdminPatientDocumentController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('upload', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientDocumentController({ execute: jest.fn() } as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido (documentType ausente)', async () => {
      const c = new AdminPatientDocumentController({ execute: jest.fn() } as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 sem file', async () => {
      const upload = { execute: jest.fn() };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(upload.execute).not.toHaveBeenCalled();
    });

    it('415 content-type não aceito', async () => {
      const c = new AdminPatientDocumentController({ execute: jest.fn() } as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'image/png', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(415);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientDocumentController({ execute: jest.fn() } as never, {} as never, { execute: jest.fn() } as never, db(false) as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('201 feliz', async () => {
      const upload = { execute: jest.fn(async () => ({ documentId: 'doc-1' })) };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(upload.execute).toHaveBeenCalledWith({ patientId: PID, buffer: Buffer.from('x'), contentType: 'application/pdf', documentType: 'image_consent', actorUid: 'uid-1' });
    });

    it('413 PatientDocumentTooLargeError', async () => {
      const upload = { execute: jest.fn(async () => { throw new PatientDocumentTooLargeError(); }) };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(413);
    });

    it('422 InvalidDocumentImageError', async () => {
      const upload = { execute: jest.fn(async () => { throw new InvalidDocumentImageError(); }) };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'image/jpeg', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('500 erro inesperado (Error)', async () => {
      const upload = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const upload = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getUrl', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientDocumentController({} as never, { execute: jest.fn() } as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientDocumentController({} as never, { execute: jest.fn() } as never, { execute: jest.fn() } as never, db(false) as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: DID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 sem documento', async () => {
      const getUrl = { execute: jest.fn(async () => null) };
      const c = new AdminPatientDocumentController({} as never, getUrl as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: DID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 feliz', async () => {
      const getUrl = { execute: jest.fn(async () => ({ url: 'https://x', expiresInSeconds: 300 })) };
      const c = new AdminPatientDocumentController({} as never, getUrl as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: DID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('500 erro inesperado', async () => {
      const getUrl = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientDocumentController({} as never, getUrl as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: DID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const getUrl = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientDocumentController({} as never, getUrl as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.getUrl(mockReq({ params: { id: PID, documentId: DID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('list', () => {
    it('400 params inválidos', async () => {
      const c = new AdminPatientDocumentController({} as never, {} as never, { execute: jest.fn() } as never, db() as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 paciente não existe', async () => {
      const c = new AdminPatientDocumentController({} as never, {} as never, { execute: jest.fn() } as never, db(false) as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 feliz — devolve a lista SEM url assinada', async () => {
      const list = { execute: jest.fn(async () => [{ id: DID, documentType: 'image_consent', contentType: 'application/pdf', sizeBytes: 10, uploadedAt: '2026-09-14T00:00:00.000Z' }]) };
      const c = new AdminPatientDocumentController({} as never, {} as never, list as never, db() as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(list.execute).toHaveBeenCalledWith(PID);
      const [payload] = res.json.mock.calls[0];
      expect(JSON.stringify(payload)).not.toMatch(/url/i);
    });

    it('200 feliz — lista vazia', async () => {
      const list = { execute: jest.fn(async () => []) };
      const c = new AdminPatientDocumentController({} as never, {} as never, list as never, db() as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('500 erro inesperado (Error)', async () => {
      const list = { execute: jest.fn(async () => { throw new Error('boom'); }) };
      const c = new AdminPatientDocumentController({} as never, {} as never, list as never, db() as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 com valor NÃO-Error lançado', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const list = { execute: jest.fn(async () => { throw 'string error'; }) };
      const c = new AdminPatientDocumentController({} as never, {} as never, list as never, db() as never);
      const res = mockRes();
      await c.list(mockReq({ params: { id: PID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  it('actorUid sem ator identificado lança (lex C6)', async () => {
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const upload = { execute: jest.fn() };
    const c = new AdminPatientDocumentController(upload as never, {} as never, { execute: jest.fn() } as never, db() as never);
    const res = mockRes();
    await c.upload(mockReq({ params: { id: PID }, body: { documentType: 'image_consent' }, file: { mimetype: 'application/pdf', buffer: Buffer.from('x') } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('constrói pelos DEFAULTS do construtor (caminho de produção)', () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new AdminPatientDocumentController();
    } finally {
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });
});
