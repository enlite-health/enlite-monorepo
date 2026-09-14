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

class FakeDocumentPathOwnershipError extends Error {
  readonly code = 'DOCUMENT_PATH_OWNERSHIP';
}

jest.mock('../../../infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    generateUploadSignedUrl: mockGenerateUploadSignedUrl,
    generateViewSignedUrl: mockGenerateViewSignedUrl,
    deleteFile: mockDeleteFile,
    getBucketName: mockGetBucketName,
  })),
  DocumentPathOwnershipError: FakeDocumentPathOwnershipError,
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

const mockFindAdditionalByWorkerId = jest.fn().mockResolvedValue([]);

jest.mock('../../../infrastructure/WorkerAdditionalDocumentsRepository', () => ({
  WorkerAdditionalDocumentsRepository: jest.fn().mockImplementation(() => ({
    findByWorkerId: mockFindAdditionalByWorkerId,
  })),
}));

const mockRecalculateStatus = jest.fn();
const mockFindAbsorbedWorkerIds = jest.fn().mockResolvedValue([]);

jest.mock('../../../infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
    recalculateStatus: mockRecalculateStatus,
    findAbsorbedWorkerIds: mockFindAbsorbedWorkerIds,
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
import { DocumentPathOwnershipError } from '../../../infrastructure/GCSStorageService';
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';

const AUTH_UID = 'auth-uid-worker-a';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_B_ID = '22222222-2222-4222-8222-222222222222';
const DOC_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNED_PATH = `workers/${WORKER_ID}/identity_document/${DOC_UUID}.pdf`;
const FOREIGN_PATH = `workers/${WORKER_B_ID}/identity_document/${DOC_UUID}.pdf`;

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
    mockFindAdditionalByWorkerId.mockResolvedValue([]);
    mockFindAbsorbedWorkerIds.mockResolvedValue([]);
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

    // ── hotfix 13/09 (extensão) — trava de prefixo do dono no SAVE ────────
    it('filePath de OUTRO worker (mesmo formato válido) → 400, nunca grava', async () => {
      const [req, res] = mockReqRes({ body: { docType: 'identity_document', filePath: FOREIGN_PATH } });
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockUploadExecute).not.toHaveBeenCalled();
    });

    it('filePath de forma "solta" (basename não-uuid) DENTRO do próprio prefixo → 200 — SAVE só checa prefixo, não a forma exata', async () => {
      mockUploadExecute.mockResolvedValue({ documentsStatus: 'submitted' });
      const [req, res] = mockReqRes({ body: { docType: 'identity_document', filePath: `workers/${WORKER_ID}/identity_document/nao-e-uuid.pdf` } });
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockUploadExecute).toHaveBeenCalled();
    });

    it('filePath path traversal → 400, nunca grava', async () => {
      const [req, res] = mockReqRes({ body: { docType: 'identity_document', filePath: '../../etc/passwd' } });
      await controller.saveDocumentPath(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockUploadExecute).not.toHaveBeenCalled();
    });

    it('nunca loga o filePath do corpo (aceito ou rejeitado)', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const warnSpy = jest.spyOn(console, 'warn');
      mockUploadExecute.mockResolvedValue({ documentsStatus: 'submitted' });

      const [reqOk, resOk] = mockReqRes({ body: { docType: 'identity_document', filePath: OWNED_PATH } });
      await controller.saveDocumentPath(reqOk, resOk);
      const [reqBad, resBad] = mockReqRes({ body: { docType: 'identity_document', filePath: FOREIGN_PATH } });
      await controller.saveDocumentPath(reqBad, resBad);

      const out = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((args) => args.join(' ')).join('\n');
      expect(out).not.toContain(OWNED_PATH);
      expect(out).not.toContain(FOREIGN_PATH);
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
      expect(mockGenerateViewSignedUrl).toHaveBeenCalledWith(OWNED_PATH, [WORKER_ID]);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { signedUrl: 'https://signed.example.com/x' } });
    });

    // ── Hotfix 14/09 — documento de worker ABSORVIDO em merge ───────────
    it('[absorvido] caminho carrega o prefixo de um worker ABSORVIDO (findAbsorbedWorkerIds não-vazio) → 200, lista repassada ao GCS', async () => {
      const absorbedId = '99999999-9999-4999-8999-999999999999';
      const absorbedPath = `workers/${absorbedId}/identity_document/${DOC_UUID}.pdf`;
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: absorbedPath });
      mockFindAbsorbedWorkerIds.mockResolvedValue([absorbedId]);
      mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/absorbed');
      const [req, res] = mockReqRes({ body: { filePath: absorbedPath } });
      await controller.getViewSignedUrl(req, res);
      expect(mockFindAbsorbedWorkerIds).toHaveBeenCalledWith(WORKER_ID);
      expect(mockGenerateViewSignedUrl).toHaveBeenCalledWith(absorbedPath, [WORKER_ID, absorbedId]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('[absorvido] findAbsorbedWorkerIds vazio → caminho de um worker qualquer fora do próprio prefixo continua 404', async () => {
      const strangerPath = `workers/88888888-8888-4888-8888-888888888888/identity_document/${DOC_UUID}.pdf`;
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockFindAbsorbedWorkerIds.mockResolvedValue([]);
      const [req, res] = mockReqRes({ body: { filePath: strangerPath } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
    });

    it('GCSStorageService recusa na 2ª camada (DocumentPathOwnershipError) → 404, nunca 500', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockGenerateViewSignedUrl.mockRejectedValue(new DocumentPathOwnershipError());
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Document not found' });
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

    // ── RED (13/09, rodada 2) ─ R1: documento ADICIONAL nunca abria ─────
    it('[R1] caminho de um documento ADICIONAL (worker_additional_documents) do PRÓPRIO worker → 200', async () => {
      const additionalPath = `workers/${WORKER_ID}/additional/${DOC_UUID}.pdf`;
      // O registro em worker_documents (11 colunas fixas) não conhece este
      // caminho — ele só existe em worker_additional_documents.
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockFindAdditionalByWorkerId.mockResolvedValue([
        { id: 'doc-1', workerId: WORKER_ID, label: 'Comprovante extra', filePath: additionalPath },
      ]);
      mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/additional');
      const [req, res] = mockReqRes({ body: { filePath: additionalPath } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // ── RED (13/09, rodada 2) ─ R2: documento INGERIDO via MCP nunca abria ─
    it('[R2] caminho INGERIDO (workers/<id>/ingested/<tipo>/<timestamp-ms>, sem extensão), já salvo no registro → 200', async () => {
      const ingestedPath = `workers/${WORKER_ID}/ingested/identity_document/${Date.now()}`;
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: ingestedPath });
      mockFindAdditionalByWorkerId.mockResolvedValue([]);
      mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/ingested');
      const [req, res] = mockReqRes({ body: { filePath: ingestedPath } });
      await controller.getViewSignedUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
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
      expect(mockDeleteFile).toHaveBeenCalledWith(OWNED_PATH, [WORKER_ID]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // ── Hotfix 14/09 — documento de worker ABSORVIDO em merge ───────────
    it('[absorvido] caminho carrega o prefixo de um worker ABSORVIDO → chama gcs.deleteFile com a lista [dono, absorvido]', async () => {
      const absorbedId = '77777777-7777-4777-8777-777777777777';
      const absorbedPath = `workers/${absorbedId}/identity_document/${DOC_UUID}.pdf`;
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: absorbedPath });
      mockFindAbsorbedWorkerIds.mockResolvedValue([absorbedId]);
      mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(mockFindAbsorbedWorkerIds).toHaveBeenCalledWith(WORKER_ID);
      expect(mockDeleteFile).toHaveBeenCalledWith(absorbedPath, [WORKER_ID, absorbedId]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro interno → 500', async () => {
      mockFindByWorkerId.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('GCSStorageService recusa na 2ª camada (DocumentPathOwnershipError) → 404, nunca apaga nem 500', async () => {
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
      mockDeleteFile.mockRejectedValue(new DocumentPathOwnershipError());
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockClearDocumentField).not.toHaveBeenCalled();
    });

    // ── RED (13/09, rodada 2) ─ R3: legado fora do prefixo travava o registro preso ─
    it('[R3] caminho LEGADO fora de workers/<id>/ → NÃO chama gcs.deleteFile, mas limpa o registro (record_only) e responde 200', async () => {
      const legacyPath = 'legacy-uploads/2019/identity-doc.pdf';
      mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: legacyPath });
      mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
      const [req, res] = mockReqRes();
      await controller.deleteDocument(req, res);
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockClearDocumentField).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
