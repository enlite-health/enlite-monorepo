/**
 * AdminWorkerDocumentsController.test.ts
 *
 * PII — e-mail de STAFF (admin) nunca aparece cru em log (gate revisao-pr, 12/09).
 *
 * Este controller loga a identidade do admin em duas famílias de linha:
 *   - ADMIN_ACTION / ADMIN_UPLOAD / ADMIN_DELETE: já tinham adminUid na mesma
 *     linha — o e-mail foi REMOVIDO (redundante para diagnóstico).
 *   - SUCCESS: só tinham adminEmail (sem uid na mesma linha) — o e-mail foi
 *     MASCARADO com maskEmailForLog (`***@dominio`).
 *
 * Este arquivo cobre as 2 famílias nos 5 endpoints, plantando um e-mail
 * sentinela e provando ausência do local-part na saída capturada do console.
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
const mockClearDocumentValidation = jest.fn();

jest.mock('../../../infrastructure/WorkerDocumentsRepository', () => ({
  WorkerDocumentsRepository: jest.fn().mockImplementation(() => ({
    findByWorkerId: mockFindByWorkerId,
    update: mockUpdate,
    clearDocumentField: mockClearDocumentField,
    clearDocumentValidation: mockClearDocumentValidation,
  })),
}));

const mockRecalculateStatus = jest.fn();
const mockFindById = jest.fn();

jest.mock('../../../infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
    recalculateStatus: mockRecalculateStatus,
    findById: mockFindById,
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

const mockUploadExecute = jest.fn();

jest.mock('../../../application/UploadWorkerDocumentsUseCase', () => ({
  UploadWorkerDocumentsUseCase: jest.fn().mockImplementation(() => ({
    execute: mockUploadExecute,
  })),
}));

const mockValidateExecute = jest.fn();

jest.mock('../../../application/ValidateWorkerDocumentUseCase', () => ({
  ValidateWorkerDocumentUseCase: jest.fn().mockImplementation(() => ({
    execute: mockValidateExecute,
  })),
}));

import { AdminWorkerDocumentsController } from '../AdminWorkerDocumentsController';
import { DocumentPathOwnershipError } from '../../../infrastructure/GCSStorageService';
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_B_ID = '22222222-2222-4222-8222-222222222222';
const DOC_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEFAULT_FILE_PATH = `workers/${WORKER_ID}/identity_document/${DOC_UUID}.pdf`;
// Local-part sentinela, improvável de aparecer por acaso em qualquer outro
// valor logado (workerId, docType, filePath) — se aparecer, é vazamento.
const SENSITIVE_LOCAL_PART = 'zzsentinela-staff-nao-pode-vazar';
const SENSITIVE_EMAIL = `${SENSITIVE_LOCAL_PART}@enlite.health`;
const ADMIN_UID = 'admin-uid-123';

function mockReqRes(overrides: Record<string, unknown> = {}): [Request, Response] {
  const req = {
    params: { id: WORKER_ID, type: 'identity_document' },
    body: { docType: 'identity_document', contentType: 'application/pdf', filePath: DEFAULT_FILE_PATH },
    user: { uid: ADMIN_UID, email: SENSITIVE_EMAIL },
    ...overrides,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('AdminWorkerDocumentsController — PII do admin nunca aparece cru em log', () => {
  let controller: AdminWorkerDocumentsController;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const capturedOutput = () =>
    [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((args) => args.join(' '))
      .join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
    controller = new AdminWorkerDocumentsController();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('getUploadSignedUrl: ADMIN_ACTION loga uid sem e-mail; SUCCESS mascara o e-mail', async () => {
    mockGenerateUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: 'workers/x/doc.pdf' });
    const [req, res] = mockReqRes();

    await controller.getUploadSignedUrl(req, res);

    const out = capturedOutput();
    expect(out).not.toContain(SENSITIVE_LOCAL_PART);
    expect(out).toContain(`adminUid: ${ADMIN_UID}`);
    expect(out).toContain('***@enlite.health');
  });

  it('saveDocumentPath: ADMIN_UPLOAD loga uid sem e-mail; SUCCESS mascara o e-mail', async () => {
    mockUploadExecute.mockResolvedValue({ documentsStatus: 'PENDING_REVIEW' });
    const [req, res] = mockReqRes();

    await controller.saveDocumentPath(req, res);

    const out = capturedOutput();
    expect(out).not.toContain(SENSITIVE_LOCAL_PART);
    expect(out).toContain(`adminUid: ${ADMIN_UID}`);
    expect(out).toContain('***@enlite.health');
  });

  it('deleteDocument: ADMIN_DELETE loga uid sem e-mail; SUCCESS mascara o e-mail', async () => {
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: null });
    const [req, res] = mockReqRes();

    await controller.deleteDocument(req, res);

    const out = capturedOutput();
    expect(out).not.toContain(SENSITIVE_LOCAL_PART);
    expect(out).toContain(`adminUid: ${ADMIN_UID}`);
    expect(out).toContain('***@enlite.health');
  });

  it('validateDocument: ADMIN_ACTION loga uid sem e-mail; SUCCESS mascara o e-mail', async () => {
    mockValidateExecute.mockResolvedValue({ documentsStatus: 'VALIDATED' });
    const [req, res] = mockReqRes();

    await controller.validateDocument(req, res);

    const out = capturedOutput();
    expect(out).not.toContain(SENSITIVE_LOCAL_PART);
    expect(out).toContain(`adminUid: ${ADMIN_UID}`);
    expect(out).toContain('***@enlite.health');
  });

  it('invalidateDocument: ADMIN_ACTION loga uid sem e-mail; SUCCESS mascara o e-mail', async () => {
    mockClearDocumentValidation.mockResolvedValue({ documentsStatus: 'PENDING_REVIEW' });
    const [req, res] = mockReqRes();

    await controller.invalidateDocument(req, res);

    const out = capturedOutput();
    expect(out).not.toContain(SENSITIVE_LOCAL_PART);
    expect(out).toContain(`adminUid: ${ADMIN_UID}`);
    expect(out).toContain('***@enlite.health');
  });

  it('admin sem e-mail (undefined): SUCCESS não quebra e não ecoa "undefined" como PII', async () => {
    mockGenerateUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: 'workers/x/doc.pdf' });
    const [req, res] = mockReqRes({ user: { uid: ADMIN_UID } });

    await controller.getUploadSignedUrl(req, res);

    const out = capturedOutput();
    expect(out).toContain('(vazio)');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('AdminWorkerDocumentsController — cobertura de ramos (401/400/404/500)', () => {
  let controller: AdminWorkerDocumentsController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
    controller = new AdminWorkerDocumentsController();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('getUploadSignedUrl: sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined });
    await controller.getUploadSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('getUploadSignedUrl: docType inválido → 400', async () => {
    const [req, res] = mockReqRes({ body: { docType: 'nao-existe' } });
    await controller.getUploadSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('getUploadSignedUrl: contentType inválido cai no default application/pdf', async () => {
    mockGenerateUploadSignedUrl.mockResolvedValue({ signedUrl: 'https://x', filePath: 'workers/x/doc.pdf' });
    const [req, res] = mockReqRes({ body: { docType: 'identity_document', contentType: 'application/exe' } });
    await controller.getUploadSignedUrl(req, res);
    expect(mockGenerateUploadSignedUrl).toHaveBeenCalledWith(WORKER_ID, 'identity_document', 'application/pdf');
  });

  it('getUploadSignedUrl: erro interno → 500', async () => {
    mockGenerateUploadSignedUrl.mockRejectedValue(new Error('gcs down'));
    const [req, res] = mockReqRes();
    await controller.getUploadSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('saveDocumentPath: sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined });
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('saveDocumentPath: docType/filePath ausente → 400', async () => {
    const [req, res] = mockReqRes({ body: { docType: 'identity_document' } });
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('saveDocumentPath: erro interno → 500', async () => {
    mockUploadExecute.mockRejectedValue(new Error('db down'));
    const [req, res] = mockReqRes();
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('deleteDocument: sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined });
    await controller.deleteDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('deleteDocument: docType inválido → 400', async () => {
    const [req, res] = mockReqRes({ params: { id: WORKER_ID, type: 'nao-existe' } });
    await controller.deleteDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('deleteDocument: sem registro existente pula gcs.deleteFile e clearDocumentField', async () => {
    mockFindByWorkerId.mockResolvedValue(null);
    const [req, res] = mockReqRes();
    await controller.deleteDocument(req, res);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockClearDocumentField).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('deleteDocument: registro existente sem filePath para o docType pula gcs.deleteFile', async () => {
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: undefined });
    mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
    const [req, res] = mockReqRes();
    await controller.deleteDocument(req, res);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockClearDocumentField).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('deleteDocument: registro existente COM filePath para o docType chama gcs.deleteFile', async () => {
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: DEFAULT_FILE_PATH });
    mockUpdate.mockResolvedValue({ identityDocumentUrl: undefined });
    const [req, res] = mockReqRes();
    await controller.deleteDocument(req, res);
    expect(mockDeleteFile).toHaveBeenCalledWith(DEFAULT_FILE_PATH, WORKER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('deleteDocument: erro interno → 500', async () => {
    mockFindByWorkerId.mockRejectedValue(new Error('db down'));
    const [req, res] = mockReqRes();
    await controller.deleteDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('deleteDocument: GCSStorageService recusa na 2ª camada (DocumentPathOwnershipError) → 404, nunca 500', async () => {
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: DEFAULT_FILE_PATH });
    mockDeleteFile.mockRejectedValue(new DocumentPathOwnershipError());
    const [req, res] = mockReqRes();
    await controller.deleteDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockClearDocumentField).not.toHaveBeenCalled();
  });

  // ── hotfix 13/09 (extensão) — trava de prefixo do dono no SAVE (lado admin) ──
  it('saveDocumentPath: filePath fora de workers/:id/... → 400, nunca grava', async () => {
    const [req, res] = mockReqRes({ body: { docType: 'identity_document', filePath: `workers/${WORKER_B_ID}/identity_document/${DOC_UUID}.pdf` } });
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUploadExecute).not.toHaveBeenCalled();
  });

  it('saveDocumentPath: filePath de forma "solta" (basename não-uuid) DENTRO do próprio prefixo → 200 — SAVE só checa prefixo', async () => {
    mockUploadExecute.mockResolvedValue({ documentsStatus: 'PENDING_REVIEW' });
    const [req, res] = mockReqRes({ body: { docType: 'identity_document', filePath: `workers/${WORKER_ID}/identity_document/nao-e-uuid.pdf` } });
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUploadExecute).toHaveBeenCalled();
  });

  it('validateDocument: sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined });
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('validateDocument: erro de cliente (Invalid document type) → 400', async () => {
    mockValidateExecute.mockRejectedValue(new Error('Invalid document type: xyz'));
    const [req, res] = mockReqRes();
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('validateDocument: erro de cliente (Cannot validate) → 400', async () => {
    mockValidateExecute.mockRejectedValue(new Error('Cannot validate this document'));
    const [req, res] = mockReqRes();
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('validateDocument: erro de cliente (Worker documents not found) → 400', async () => {
    mockValidateExecute.mockRejectedValue(new Error('Worker documents not found'));
    const [req, res] = mockReqRes();
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('validateDocument: admin sem e-mail → adminEmail vazio é passado ao use case', async () => {
    mockValidateExecute.mockResolvedValue({ documentsStatus: 'VALIDATED' });
    const [req, res] = mockReqRes({ user: { uid: ADMIN_UID } });
    await controller.validateDocument(req, res);
    expect(mockValidateExecute).toHaveBeenCalledWith(expect.objectContaining({ adminEmail: '' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('validateDocument: erro não-cliente → 500', async () => {
    mockValidateExecute.mockRejectedValue(new Error('boom'));
    const [req, res] = mockReqRes();
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('validateDocument: erro não-Error lançado → 500 com mensagem genérica', async () => {
    mockValidateExecute.mockRejectedValue('string-error');
    const [req, res] = mockReqRes();
    await controller.validateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal server error' });
  });

  it('invalidateDocument: sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined });
    await controller.invalidateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('invalidateDocument: docType inválido → 400', async () => {
    const [req, res] = mockReqRes({ params: { id: WORKER_ID, type: 'nao-existe' } });
    await controller.invalidateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('invalidateDocument: erro interno → 500', async () => {
    mockClearDocumentValidation.mockRejectedValue(new Error('db down'));
    const [req, res] = mockReqRes();
    await controller.invalidateDocument(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('recordAdminUpload: falha na trilha de auditoria não derruba a operação principal', async () => {
    mockDbQuery.mockRejectedValue(new Error('audit table down'));
    mockUploadExecute.mockResolvedValue({ documentsStatus: 'PENDING_REVIEW' });
    const [req, res] = mockReqRes();
    await controller.saveDocumentPath(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('recordAdminUpload: admin sem e-mail grava null na trilha', async () => {
    mockUploadExecute.mockResolvedValue({ documentsStatus: 'PENDING_REVIEW' });
    const [req, res] = mockReqRes({ user: { uid: ADMIN_UID } });
    await controller.saveDocumentPath(req, res);
    expect(mockDbQuery).toHaveBeenCalledWith(expect.any(String), [WORKER_ID, ADMIN_UID, null]);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('AdminWorkerDocumentsController.getViewSignedUrl — URL assinada só para documento do próprio worker', () => {
  let controller: AdminWorkerDocumentsController;

  const OWNED_PATH = DEFAULT_FILE_PATH;
  const FOREIGN_PATH = `workers/${WORKER_B_ID}/identity_document/${DOC_UUID}.pdf`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
    controller = new AdminWorkerDocumentsController();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sem admin → 401', async () => {
    const [req, res] = mockReqRes({ user: undefined, body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('filePath ausente ou não-string → 400', async () => {
    const [req, res] = mockReqRes({ body: {} });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it(':id inexistente (findById retorna null) → 404, nunca chega a assinar', async () => {
    mockFindById.mockResolvedValue(Result.ok(null));
    const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it(':id inexistente (findById falha) → 404', async () => {
    mockFindById.mockResolvedValue(Result.fail('not found'));
    const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it('caminho de OUTRO worker (não está em worker_documents deste :id) → 404, nunca assina', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
    const [req, res] = mockReqRes({ body: { filePath: FOREIGN_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Document not found' });
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it('path traversal ("..") → 404, nunca assina', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
    const [req, res] = mockReqRes({ body: { filePath: '../../etc/passwd' } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it('bucket/host diferente → 404, nunca assina', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
    const [req, res] = mockReqRes({ body: { filePath: 'https://evil.example.com/workers/x/doc.pdf' } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it('worker sem registro de documentos (findByWorkerId null) → 404', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue(null);
    const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGenerateViewSignedUrl).not.toHaveBeenCalled();
  });

  it('caminho pertence ao worker correto → 200 com signedUrl', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
    mockGenerateViewSignedUrl.mockResolvedValue('https://signed.example.com/x');
    const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(mockGenerateViewSignedUrl).toHaveBeenCalledWith(OWNED_PATH, WORKER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { signedUrl: 'https://signed.example.com/x' } });
  });

  it('GCSStorageService recusa na 2ª camada (DocumentPathOwnershipError) → 404, nunca 500', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
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
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
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

  it('erro interno (ex.: gcs.generateViewSignedUrl falha) → 500', async () => {
    mockFindById.mockResolvedValue(Result.ok({ id: WORKER_ID }));
    mockFindByWorkerId.mockResolvedValue({ identityDocumentUrl: OWNED_PATH });
    mockGenerateViewSignedUrl.mockRejectedValue(new Error('gcs down'));
    const [req, res] = mockReqRes({ body: { filePath: OWNED_PATH } });
    await controller.getViewSignedUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
