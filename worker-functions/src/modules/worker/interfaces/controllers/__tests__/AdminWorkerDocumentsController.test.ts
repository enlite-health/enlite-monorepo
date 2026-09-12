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

jest.mock('../../../infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    generateUploadSignedUrl: mockGenerateUploadSignedUrl,
    generateViewSignedUrl: mockGenerateViewSignedUrl,
    deleteFile: mockDeleteFile,
  })),
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

jest.mock('../../../infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
    recalculateStatus: mockRecalculateStatus,
    findById: jest.fn(),
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
import { Request, Response } from 'express';

const WORKER_ID = 'worker-aaaa-bbbb';
// Local-part sentinela, improvável de aparecer por acaso em qualquer outro
// valor logado (workerId, docType, filePath) — se aparecer, é vazamento.
const SENSITIVE_LOCAL_PART = 'zzsentinela-staff-nao-pode-vazar';
const SENSITIVE_EMAIL = `${SENSITIVE_LOCAL_PART}@enlite.health`;
const ADMIN_UID = 'admin-uid-123';

function mockReqRes(overrides: Record<string, unknown> = {}): [Request, Response] {
  const req = {
    params: { id: WORKER_ID, type: 'identity_document' },
    body: { docType: 'identity_document', contentType: 'application/pdf', filePath: 'workers/x/doc.pdf' },
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
