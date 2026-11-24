/**
 * Testes unitários para UploadWorkerDocumentsUseCase.
 *
 * Cobre:
 * - Lança erro quando worker não existe
 * - Chama create quando não há documentos prévios
 * - Chama update quando já existem documentos
 * - Persiste o campo correto para cada um dos 8 docTypes
 * - Retorna WorkerDocuments após criar novo registro
 * - Retorna WorkerDocuments após atualizar registro existente
 */

import { UploadWorkerDocumentsUseCase, IWorkerDocumentsRepository, WorkerDocuments, IWorkerRepository } from '../../../src/modules/worker';

// ── Factories ────────────────────────────────────────────────────────────────

const makeRepo = (
  overrides: Partial<IWorkerDocumentsRepository> = {},
): jest.Mocked<IWorkerDocumentsRepository> =>
  ({
    create: jest.fn(),
    findByWorkerId: jest.fn(),
    update: jest.fn(),
    review: jest.fn(),
    delete: jest.fn(),
    clearDocumentField: jest.fn(),
    validateDocument: jest.fn(),
    clearDocumentValidation: jest.fn(),
    ...overrides,
  } as jest.Mocked<IWorkerDocumentsRepository>);

const makeWorkerRepo = (
  overrides: Partial<IWorkerRepository> = {},
): jest.Mocked<IWorkerRepository> =>
  ({
    create: jest.fn(),
    findById: jest.fn(),
    findByAuthUid: jest.fn(),
    findByEmail: jest.fn(),
    findByPhone: jest.fn(),
    findByPhoneCandidates: jest.fn(),
    updatePersonalInfo: jest.fn(),
    updateAuthUid: jest.fn(),
    updateImportedWorkerData: jest.fn(),
    updateStatus: jest.fn(),
    recalculateStatus: jest.fn(),
    delete: jest.fn(),
    deleteByAuthUid: jest.fn(),
    ...overrides,
  } as jest.Mocked<IWorkerRepository>);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORKER_ID = 'worker-1';

const workerResultOk = {
  isSuccess: true,
  getValue: () => ({ id: WORKER_ID, email: 'worker@test.com' }),
};

const workerResultNotFound = {
  isSuccess: false,
  getValue: () => null,
};

const workerResultNullValue = {
  isSuccess: true,
  getValue: () => null,
};

const baseDocuments: WorkerDocuments = {
  id: 'doc-1',
  workerId: WORKER_ID,
  resumeCvUrl: 'workers/worker-1/resume_cv/file.pdf',
  identityDocumentUrl: undefined,
  identityDocumentBackUrl: undefined,
  criminalRecordUrl: undefined,
  professionalRegistrationUrl: undefined,
  liabilityInsuranceUrl: undefined,
  monotributoCertificateUrl: undefined,
  atCertificateUrl: undefined,
  additionalCertificatesUrls: [],
  documentsStatus: 'incomplete',
  documentValidations: {},
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ── Testes ────────────────────────────────────────────────────────────────────

describe('UploadWorkerDocumentsUseCase', () => {
  // ── Worker inexistente ─────────────────────────────────────────────────────

  it('lança erro quando worker não existe (isSuccess: false)', async () => {
    const docsRepo = makeRepo();
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultNotFound),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await expect(
      useCase.execute({ workerId: WORKER_ID, resumeCvUrl: 'workers/test/resume_cv/file.pdf' }),
    ).rejects.toThrow(/worker not found/i);

    expect(docsRepo.create).not.toHaveBeenCalled();
    expect(docsRepo.update).not.toHaveBeenCalled();
  });

  it('lança erro quando worker não existe (isSuccess: true mas valor null)', async () => {
    const docsRepo = makeRepo();
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultNullValue),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await expect(
      useCase.execute({ workerId: WORKER_ID, resumeCvUrl: 'workers/test/resume_cv/file.pdf' }),
    ).rejects.toThrow(/worker not found/i);

    expect(docsRepo.create).not.toHaveBeenCalled();
    expect(docsRepo.update).not.toHaveBeenCalled();
  });

  // ── Criação de novo registro ───────────────────────────────────────────────

  it('chama create quando worker não tem documentos prévios', async () => {
    const createdDocs: WorkerDocuments = { ...baseDocuments, resumeCvUrl: 'workers/test/resume_cv/file.pdf' };
    const docsRepo = makeRepo({
      findByWorkerId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdDocs),
    });
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultOk),
      recalculateStatus: jest.fn().mockResolvedValue(null),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await useCase.execute({ workerId: WORKER_ID, resumeCvUrl: 'workers/test/resume_cv/file.pdf' });

    expect(docsRepo.create).toHaveBeenCalledTimes(1);
    expect(docsRepo.update).not.toHaveBeenCalled();
    expect(workerRepo.recalculateStatus).toHaveBeenCalledWith(WORKER_ID, { flow: 'WORKER_DOCUMENT_UPLOAD' });
  });

  // ── Atualização de registro existente ─────────────────────────────────────

  it('chama update quando worker já tem documentos', async () => {
    const updatedDocs: WorkerDocuments = {
      ...baseDocuments,
      criminalRecordUrl: 'workers/test/criminal_record/file.pdf',
    };
    const docsRepo = makeRepo({
      findByWorkerId: jest.fn().mockResolvedValue(baseDocuments),
      update: jest.fn().mockResolvedValue(updatedDocs),
    });
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultOk),
      recalculateStatus: jest.fn().mockResolvedValue(null),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await useCase.execute({ workerId: WORKER_ID, criminalRecordUrl: 'workers/test/criminal_record/file.pdf' });

    expect(docsRepo.update).toHaveBeenCalledTimes(1);
    expect(docsRepo.create).not.toHaveBeenCalled();
    expect(workerRepo.recalculateStatus).toHaveBeenCalledWith(WORKER_ID, { flow: 'WORKER_DOCUMENT_UPLOAD' });
  });

  // ── Mapeamento docType → jsField ──────────────────────────────────────────

  const docTypeFieldMappings: Array<{ jsField: keyof WorkerDocuments; path: string }> = [
    { jsField: 'resumeCvUrl',               path: 'workers/test/resume_cv/file.pdf' },
    { jsField: 'identityDocumentUrl',        path: 'workers/test/identity_document/file.pdf' },
    { jsField: 'identityDocumentBackUrl',    path: 'workers/test/identity_document_back/file.pdf' },
    { jsField: 'criminalRecordUrl',          path: 'workers/test/criminal_record/file.pdf' },
    { jsField: 'professionalRegistrationUrl', path: 'workers/test/professional_registration/file.pdf' },
    { jsField: 'liabilityInsuranceUrl',      path: 'workers/test/liability_insurance/file.pdf' },
    { jsField: 'monotributoCertificateUrl',  path: 'workers/test/monotributo_certificate/file.pdf' },
    { jsField: 'atCertificateUrl',           path: 'workers/test/at_certificate/file.pdf' },
  ];

  it.each(docTypeFieldMappings)(
    'persiste o campo correto para $jsField',
    async ({ jsField, path }) => {
      const dto = { workerId: WORKER_ID, [jsField]: path };
      const savedDocs: WorkerDocuments = { ...baseDocuments, [jsField]: path };

      const docsRepo = makeRepo({
        findByWorkerId: jest.fn().mockResolvedValue(baseDocuments),
        update: jest.fn().mockResolvedValue(savedDocs),
      });
      const workerRepo = makeWorkerRepo({
        findById: jest.fn().mockResolvedValue(workerResultOk),
        recalculateStatus: jest.fn().mockResolvedValue(null),
      });
      const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

      await useCase.execute(dto);

      expect(docsRepo.update).toHaveBeenCalledWith(expect.objectContaining({ [jsField]: path }));
    },
  );

  // ── Valor de retorno ───────────────────────────────────────────────────────

  it('retorna WorkerDocuments após criar novo registro', async () => {
    const createdDocs: WorkerDocuments = {
      ...baseDocuments,
      id: 'doc-new',
      resumeCvUrl: 'workers/test/resume_cv/file.pdf',
      documentsStatus: 'incomplete',
    };
    const docsRepo = makeRepo({
      findByWorkerId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdDocs),
    });
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultOk),
      recalculateStatus: jest.fn().mockResolvedValue(null),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    const result = await useCase.execute({ workerId: WORKER_ID, resumeCvUrl: 'workers/test/resume_cv/file.pdf' });

    expect(result).toBe(createdDocs);
    expect(result.id).toBe('doc-new');
    expect(result.resumeCvUrl).toBe('workers/test/resume_cv/file.pdf');
  });

  it('retorna WorkerDocuments após atualizar registro existente', async () => {
    const updatedDocs: WorkerDocuments = {
      ...baseDocuments,
      criminalRecordUrl: 'workers/test/criminal_record/file.pdf',
      documentsStatus: 'submitted',
    };
    const docsRepo = makeRepo({
      findByWorkerId: jest.fn().mockResolvedValue(baseDocuments),
      update: jest.fn().mockResolvedValue(updatedDocs),
    });
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultOk),
      recalculateStatus: jest.fn().mockResolvedValue(null),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    const result = await useCase.execute({
      workerId: WORKER_ID,
      criminalRecordUrl: 'workers/test/criminal_record/file.pdf',
    });

    expect(result).toBe(updatedDocs);
    expect(result.documentsStatus).toBe('submitted');
    expect(result.criminalRecordUrl).toBe('workers/test/criminal_record/file.pdf');
  });

  // ── recalculateStatus sempre chamado ─────────────────────────────────────

  it('sempre chama recalculateStatus ao final, independente do fluxo', async () => {
    const docsRepo = makeRepo({
      findByWorkerId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(baseDocuments),
    });
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultOk),
      recalculateStatus: jest.fn().mockResolvedValue('active'),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await useCase.execute({ workerId: WORKER_ID });

    expect(workerRepo.recalculateStatus).toHaveBeenCalledTimes(1);
    expect(workerRepo.recalculateStatus).toHaveBeenCalledWith(WORKER_ID, { flow: 'WORKER_DOCUMENT_UPLOAD' });
  });

  it('não chama recalculateStatus quando worker não existe', async () => {
    const docsRepo = makeRepo();
    const workerRepo = makeWorkerRepo({
      findById: jest.fn().mockResolvedValue(workerResultNotFound),
      recalculateStatus: jest.fn(),
    });
    const useCase = new UploadWorkerDocumentsUseCase(docsRepo, workerRepo);

    await expect(useCase.execute({ workerId: WORKER_ID })).rejects.toThrow();

    expect(workerRepo.recalculateStatus).not.toHaveBeenCalled();
  });
});
