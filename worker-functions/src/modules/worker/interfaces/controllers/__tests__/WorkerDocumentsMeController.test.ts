/**
 * WorkerDocumentsMeController.test.ts
 *
 * Cobertura completa do controller, incluindo o guard do hotfix
 * `getViewSignedUrl` (D-2026-09-13): antes, o servidor assinava QUALQUER
 * `filePath` do corpo sem checar que pertence ao worker autenticado — um
 * worker A podia ler o documento de um worker B só sabendo o path.
 */

const mockGenerateUploadSignedUrl = jest.fn();
const mockGenerateViewSignedUrl = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetBucketName = jest.fn().mockReturnValue('enlite-worker-documents');

jest.mock('../../../infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    generateUploadSignedUrl: mockGenerateUploadSignedUrl,
    generateViewSignedUrl: mockGenerateViewSignedUrl,
    deleteFile: mockDeleteFile,
    getBucketName: mockGetBucketName,
  })),
}));

const mockFindByWorkerId = jest.fn();
const mockUpdate = jest.fn();
const mockClearDocumentField = jest.fn();

jest.mock('../../../infrastructure/WorkerDocumentsRepository', () => ({
  WorkerDocumentsRepository: jest.fn().mockImplementation(() => ({
    findByWorkerId: mockFindByWorkerId,
    update: mockUpdate,
    clearDocumentField: mockClearDocumentField,
  })),
}));

const mockRecalculateStatus = jest.fn();

jest.mock('../../../infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
    recalculateStatus: mockRecalculateStatus,
  })),
}));

const mockDbQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockDbQuery }),
    }),
  },
}));

const mockGetProgressExecute = jest.fn();

jest.mock('../../../application/GetWorkerProgressUseCase', () => ({
  GetWorkerProgressUseCase: jest.fn().mockImplementation(() => ({
    execute: mockGetProgressExecute,
  })),
}));

const mockUploadExecute = jest.fn();

jest.mock('../../../application/UploadWorkerDocumentsUseCase', () => ({
  UploadWorkerDocumentsUseCase: jest.fn().mockImplementation(() => ({
    execute: mockUploadExecute,
  })),
}));

import { WorkerDocumentsMeController } from '../WorkerDocumentsMeController';
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';

const AUTH_UID = 'auth-uid-worker-a';
const WORKER_ID = 'worker-a-id';
const OWNED_PATH = 'workers/worker-a-id/identity_document/real-doc.pdf';
const FOREIGN_PATH = 'workers/worker-b-id/identity_document/outro-doc.pdf';

function mockReqRes(overrides: Record<string, unknown> = {}): [Request, Response] {
  const req = {
    params: { type: 'identity_document' },
    headers: {},
    body: { docType: 'identity_document', contentType: 'application/pdf', filePath: OWNED_PATH },
    user: { uid: AUTH_UID },
    ...overrides,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WorkerDocumentsMeController', () => {
  let controller: WorkerDocumentsMeController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockGetProgressExecute.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    controller = new WorkerDocumentsMeController();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── getDocuments ──────────────────────────────────────────────────────
  describe('getDocuments', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.getDocuments(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.getDocuments(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → 200 com os documentos', async () => {
      mockFindByWorkerId.mockResolvedValue({ documentsStatus: 'submitted' });
      const [req, res] = mockReqRes();
      await controller.getDocuments(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { documentsStatus: 'submitted' } });
    });

    it('sem registro de documentos ainda (null) → 200 com data null', async () => {
      mockFindByWorkerId.mockResolvedValue(null);
      const [req, res] = mockReqRes();
      await controller.getDocuments(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
    });

    it('erro interno → 500', async () => {
      mockFindByWorkerId.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.getDocuments(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── getUploadSignedUrl ───────────────────────────────────────────────
  describe('getUploadSignedUrl', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.getUploadSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('docType inválido → 400', async () => {
      const [req, res] = mockReqRes({ body: { docType: 'nao-existe' } });
      await controller.getUploadSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('contentType inválido cai no default application/pdf', async () => {
      mockGenerateUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: OWNED_PATH });
      const [req, res] = mockReqRes({ body: { docType: 'identity_document', contentType: 'application/exe' } });
      await controller.getUploadSignedUrl(req, res);
      expect(mockGenerateUploadSignedUrl).toHaveBeenCalledWith(WORKER_ID, 'identity_document', 'application/pdf');
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.getUploadSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → 200', async () => {
      mockGenerateUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: OWNED_PATH });
      const [req, res] = mockReqRes();
      await controller.getUploadSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro interno → 500', async () => {
      mockGenerateUploadSignedUrl.mockRejectedValue(new Error('gcs down'));
      const [req, res] = mockReqRes();
      await controller.getUploadSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── saveDocumentPath ─────────────────────────────────────────────────
  describe('saveDocumentPath', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('docType/filePath ausente → 400', async () => {
      const [req, res] = mockReqRes({ body: { docType: 'identity_document' } });
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → 200', async () => {
      mockUploadExecute.mockResolvedValue({ documentsStatus: 'submitted' });
      const [req, res] = mockReqRes();
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro interno → 500', async () => {
      mockUploadExecute.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── getViewSignedUrl (hotfix) ────────────────────────────────────────
  describe('getViewSignedUrl — URL assinada só para documento do próprio worker', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('filePath ausente ou não-string → 400', async () => {
      const [req, res] = mockReqRes({ body: {} });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('conta sem worker (resolveWorker falha) → 404, nunca chega a assinar', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('caminho de OUTRO worker → 404, nunca assina', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      const [req, res] = mockReqRes({ body: { filePath: FOREIGN_PATH } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Document not found' });
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('path traversal ("..") → 404, nunca assina', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      const [req, res] = mockReqRes({ body: { filePath: '../../etc/passwd' } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('bucket/host diferente → 404, nunca assina', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      const [req, res] = mockReqRes({ body: { filePath: 'https://evil.example.com/workers/x/doc.pdf' } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('worker sem registro de documentos (findByWorkerId null) → 404', async () => {
      mockFindByWorkerId.mockResolvedValue(null);
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('caminho pertence ao PRÓPRIO worker → 200 com signedUrl', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/x');
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
      await controller.getViewSignedUrl(req, res);
      expect(mockGenerateViewSignedUrl).toHaveBeenCalledWith(OWNED_PATH);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { signedUrl: 'https://signed.example.com/x' } });
    });

    it('nunca loga o filePath (aceito ou rejeitado) nem o corpo da requisição', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const warnSpy = jest.spyOn(console, 'warn');
      const errorSpy = jest.spyOn(console, 'error');
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/x');

      const [reqOk, resOk] = mockReqRes({ body: { filePath: OWNED_PATH } });
      await controller.getViewSignedUrl(reqOk, resOk);
      const [reqBad, resBad] = mockReqRes({ body: { filePath: FOREIGN_PATH } });
      await controller.getViewSignedUrl(reqBad, resBad);

      const out = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.join(' ')).join('\n');
      expect(out).not.toContain(OWNED_PATH);
      expect(out).not.toContain(FOREIGN_PATH);
    });

    it('erro interno (gcs.generateViewSignedUrl falha) → 500', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockGenerateViewSignedUrl.mockRejectedValue(new Error('gcs down'));
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── deleteDocument ───────────────────────────────────────────────────
  describe('deleteDocument', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('docType inválido → 400', async () => {
      const [req, res] = mockReqRes({ params: { type: 'nao-existe' } });
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sem registro existente pula gcs.deleteFile e clearDocumentField', async () => {
      mockFindByWorkerId.mockResolvedValue(null);
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockClearDocumentField).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('registro existente sem filePath para o docType pula gcs.deleteFile mas limpa o campo', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: undefined });
      mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockClearDocumentField).toHaveBeenCalled();
      expect(mockRecalculateStatus).toHaveBeenCalledWith(WORKER_ID);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('registro existente COM filePath chama gcs.deleteFile', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(mockDeleteFile).toHaveBeenCalledWith(OWNED_PATH);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro interno → 500', async () => {
      mockFindByWorkerId.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
