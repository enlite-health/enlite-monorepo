/**
 * WorkerAdditionalDocsMeController.test.ts
 *
 * Hotfix 13/09 (extensão): `save` aceitava `filePath` do corpo sem checar
 * prefixo — um worker A podia gravar o caminho de um documento adicional de
 * B no PRÓPRIO registro; `remove` então chamava `gcs.deleteFile` com esse
 * caminho, apagando o objeto de B. `matchesOwnedDocumentPathShape` fecha o
 * SAVE (400 fora de `workers/<próprio id>/additional/<uuid>.<ext>`); o
 * `GCSStorageService` real aplica a mesma checagem como 2ª camada no delete.
 */

const mockGenerateAdditionalUploadSignedUrl = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetBucketName = jest.fn().mockReturnValue('enlite-worker-documents');

class FakeDocumentPathOwnershipError extends Error {
  readonly code = 'DOCUMENT_PATH_OWNERSHIP';
}

jest.mock('../../../infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    generateAdditionalUploadSignedUrl: mockGenerateAdditionalUploadSignedUrl,
    deleteFile: mockDeleteFile,
    getBucketName: mockGetBucketName,
  })),
  DocumentPathOwnershipError: FakeDocumentPathOwnershipError,
}));

const mockFindByWorkerId = jest.fn();
const mockCreate = jest.fn();
const mockDeleteById = jest.fn();

jest.mock('../../../infrastructure/WorkerAdditionalDocumentsRepository', () => ({
  WorkerAdditionalDocumentsRepository: jest.fn().mockImplementation(() => ({
    findByWorkerId: mockFindByWorkerId,
    create: mockCreate,
    deleteById: mockDeleteById,
  })),
}));

const mockFindAbsorbedWorkerIds = jest.fn().mockResolvedValue([]);

jest.mock('../../../infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
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

import { WorkerAdditionalDocsMeController } from '../WorkerAdditionalDocsMeController';
import { DocumentPathOwnershipError } from '../../../infrastructure/GCSStorageService';
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';

const AUTH_UID = 'auth-uid-worker-a';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_B_ID = '22222222-2222-4222-8222-222222222222';
const DOC_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNED_PATH = `workers/${WORKER_ID}/additional/${DOC_UUID}.pdf`;
const FOREIGN_PATH = `workers/${WORKER_B_ID}/additional/${DOC_UUID}.pdf`;

function mockReqRes(overrides: Record<string, unknown> = {}): [Request, Response] {
  const req = {
    params: { id: 'doc-1' },
    headers: {},
    body: { label: 'Certificado extra', filePath: OWNED_PATH, contentType: 'application/pdf' },
    user: { uid: AUTH_UID },
    ...overrides,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WorkerAdditionalDocsMeController', () => {
  let controller: WorkerAdditionalDocsMeController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockGetProgressExecute.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindAbsorbedWorkerIds.mockResolvedValue([]);
    controller = new WorkerAdditionalDocsMeController();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.list(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.list(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → 200 com a lista', async () => {
      mockFindByWorkerId.mockResolvedValue([{ id: 'doc-1', label: 'x' }]);
      const [req, res] = mockReqRes();
      await controller.list(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ id: 'doc-1', label: 'x' }] });
    });

    it('erro interno → 500', async () => {
      mockFindByWorkerId.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.list(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getUploadUrl', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.getUploadUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('contentType inválido cai no default application/pdf', async () => {
      mockGenerateAdditionalUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: OWNED_PATH });
      const [req, res] = mockReqRes({ body: { contentType: 'application/exe' } });
      await controller.getUploadUrl(req, res);
      expect(mockGenerateAdditionalUploadSignedUrl).toHaveBeenCalledWith(WORKER_ID, 'application/pdf');
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.getUploadUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → 200', async () => {
      mockGenerateAdditionalUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: OWNED_PATH });
      const [req, res] = mockReqRes();
      await controller.getUploadUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro interno → 500', async () => {
      mockGenerateAdditionalUploadSignedUrl.mockRejectedValue(new Error('gcs down'));
      const [req, res] = mockReqRes();
      await controller.getUploadUrl(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('save', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('label ausente ou só espaço → 400', async () => {
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH, label: '   ' } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('label maior que 255 chars → 400', async () => {
      const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH, label: 'x'.repeat(256) } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('filePath ausente → 400', async () => {
      const [req, res] = mockReqRes({ body: { label: 'x' } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso (filePath próprio, forma válida) → 201', async () => {
      mockCreate.mockResolvedValue({ id: 'doc-1', label: 'Certificado extra', filePath: OWNED_PATH });
      const [req, res] = mockReqRes();
      await controller.save(req, res);
      expect(mockCreate).toHaveBeenCalledWith({ workerId: WORKER_ID, label: 'Certificado extra', filePath: OWNED_PATH });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('erro interno → 500', async () => {
      mockCreate.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    // ── hotfix 13/09 (extensão) — trava de prefixo do dono ────────────────
    it('filePath de OUTRO worker (mesmo formato válido) → 400, nunca grava', async () => {
      const [req, res] = mockReqRes({ body: { label: 'x', filePath: FOREIGN_PATH } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('filePath de forma "solta" (basename não-uuid) DENTRO do próprio prefixo → 201 — SAVE só checa prefixo', async () => {
      mockCreate.mockResolvedValue({ id: 'doc-2' });
      const [req, res] = mockReqRes({ body: { label: 'x', filePath: `workers/${WORKER_ID}/additional/nao-e-uuid.pdf` } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockCreate).toHaveBeenCalled();
    });

    it('filePath path traversal → 400, nunca grava', async () => {
      const [req, res] = mockReqRes({ body: { label: 'x', filePath: '../../etc/passwd' } });
      await controller.save(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('nunca loga o filePath do corpo (aceito ou rejeitado)', async () => {
      const logSpy = jest.spyOn(console, 'log');
      const warnSpy = jest.spyOn(console, 'warn');
      mockCreate.mockResolvedValue({ id: 'doc-1' });

      const [reqOk, resOk] = mockReqRes({ body: { label: 'x', filePath: OWNED_PATH } });
      await controller.save(reqOk, resOk);
      const [reqBad, resBad] = mockReqRes({ body: { label: 'x', filePath: FOREIGN_PATH } });
      await controller.save(reqBad, resBad);

      const out = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((a) => a.join(' ')).join('\n');
      expect(out).not.toContain(OWNED_PATH);
      expect(out).not.toContain(FOREIGN_PATH);
    });
  });

  describe('remove', () => {
    it('sem authUid → 401', async () => {
      const [req, res] = mockReqRes({ user: undefined });
      await controller.remove(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('worker não encontrado → 404', async () => {
      mockGetProgressExecute.mockResolvedValue(Result.fail('not found'));
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('doc não encontrado na lista do worker pula gcs.deleteFile mas ainda chama deleteById', async () => {
      mockFindByWorkerId.mockResolvedValue([]);
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockDeleteById).toHaveBeenCalledWith('doc-1', WORKER_ID);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('doc encontrado chama gcs.deleteFile com o filePath e a lista de ids permitidos [workerId], depois deleteById', async () => {
      mockFindByWorkerId.mockResolvedValue([{ id: 'doc-1', filePath: OWNED_PATH }]);
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(mockDeleteFile).toHaveBeenCalledWith(OWNED_PATH, [WORKER_ID]);
      expect(mockDeleteById).toHaveBeenCalledWith('doc-1', WORKER_ID);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // ── Hotfix 14/09 — documento de worker ABSORVIDO em merge ───────────
    it('[absorvido] filePath carrega o prefixo de um worker ABSORVIDO → deleteFile recebe [dono, absorvido]', async () => {
      const absorbedId = '55555555-5555-4555-8555-555555555555';
      const absorbedPath = `workers/${absorbedId}/additional/${DOC_UUID}.pdf`;
      mockFindByWorkerId.mockResolvedValue([{ id: 'doc-1', filePath: absorbedPath }]);
      mockFindAbsorbedWorkerIds.mockResolvedValue([absorbedId]);
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(mockFindAbsorbedWorkerIds).toHaveBeenCalledWith(WORKER_ID);
      expect(mockDeleteFile).toHaveBeenCalledWith(absorbedPath, [WORKER_ID, absorbedId]);
      expect(mockDeleteById).toHaveBeenCalledWith('doc-1', WORKER_ID);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('GCSStorageService recusa na 2ª camada (DocumentPathOwnershipError) → 404, nunca deleteById nem 500', async () => {
      mockFindByWorkerId.mockResolvedValue([{ id: 'doc-1', filePath: OWNED_PATH }]);
      mockDeleteFile.mockRejectedValue(new DocumentPathOwnershipError());
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockDeleteById).not.toHaveBeenCalled();
    });

    it('erro interno → 500', async () => {
      mockFindByWorkerId.mockRejectedValue(new Error('db down'));
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    // ── RED (13/09, rodada 2) ─ R3: legado fora do prefixo travava o registro preso ─
    it('[R3] caminho LEGADO fora de workers/<id>/additional/ → NÃO chama gcs.deleteFile, mas apaga o registro (record_only) e responde 200', async () => {
      const legacyPath = 'legacy-uploads/2019/comprovante-antigo.pdf';
      mockFindByWorkerId.mockResolvedValue([{ id: 'doc-1', filePath: legacyPath }]);
      const [req, res] = mockReqRes();
      await controller.remove(req, res);
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockDeleteById).toHaveBeenCalledWith('doc-1', WORKER_ID);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
