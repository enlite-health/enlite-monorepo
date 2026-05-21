/**
 * IngestDocumentFromUrlUseCase.test.ts
 */
import { Result } from '@shared/utils/Result';

const mockFindById = jest.fn();
const mockDownload = jest.fn();
const mockUploadBuffer = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('@modules/worker/infrastructure/WorkerRepository', () => ({
  WorkerRepository: jest.fn().mockImplementation(() => ({
    findById: mockFindById,
  })),
}));

jest.mock('@modules/worker/infrastructure/ExternalMediaDownloader', () => ({
  ExternalMediaDownloader: jest.fn().mockImplementation(() => ({
    download: mockDownload,
  })),
}));

jest.mock('@modules/worker/infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    uploadBuffer: mockUploadBuffer,
  })),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
  reportError: jest.fn(),
  loggingAls: { getStore: jest.fn().mockReturnValue({ traceId: 'trace-1' }) },
}));

import {
  IngestDocumentFromUrlUseCase,
  WorkerNotFoundError,
  HostBlockedError,
  FileTooLargeError,
  ContentTypeMismatchError,
  DownloadError,
} from '../IngestDocumentFromUrlUseCase';

describe('IngestDocumentFromUrlUseCase', () => {
  const useCase = new IngestDocumentFromUrlUseCase();
  const validWorker = { id: 'worker-1', status: 'REGISTERED' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue(Result.ok(validWorker));
    mockDownload.mockResolvedValue({ buffer: Buffer.from('data'), contentType: 'application/pdf' });
    mockUploadBuffer.mockResolvedValue(undefined);
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('retorna filePath quando download e upload são bem-sucedidos', async () => {
    const result = await useCase.execute({
      workerId: 'worker-1',
      documentType: 'resume_cv',
      externalUrl: 'https://example.com/doc.pdf',
    });

    expect(result.workerId).toBe('worker-1');
    expect(result.documentType).toBe('resume_cv');
    expect(result.filePath).toContain('workers/worker-1/ingested/resume_cv');
    expect(mockUploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('lança WorkerNotFoundError quando worker não existe', async () => {
    mockFindById.mockResolvedValue(Result.ok(null));

    await expect(
      useCase.execute({ workerId: 'no-such', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
    ).rejects.toThrow(WorkerNotFoundError);
  });

  it('propaga HostBlockedError do downloader', async () => {
    mockDownload.mockRejectedValue(new HostBlockedError('Host blocked'));

    await expect(
      useCase.execute({ workerId: 'worker-1', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
    ).rejects.toThrow(HostBlockedError);
  });

  it('propaga FileTooLargeError do downloader', async () => {
    mockDownload.mockRejectedValue(new FileTooLargeError('Too large'));

    await expect(
      useCase.execute({ workerId: 'worker-1', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
    ).rejects.toThrow(FileTooLargeError);
  });

  it('lança ContentTypeMismatchError para content-type não suportado', async () => {
    mockDownload.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'text/html' });

    await expect(
      useCase.execute({ workerId: 'worker-1', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
    ).rejects.toThrow(ContentTypeMismatchError);
  });

  it('lança DownloadError quando GCS falha', async () => {
    mockUploadBuffer.mockRejectedValue(new Error('GCS error'));

    await expect(
      useCase.execute({ workerId: 'worker-1', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
    ).rejects.toThrow(DownloadError);
  });

  describe('TD-027 — domain event worker.document.uploaded', () => {
    it('emite evento worker.document.uploaded no happy path', async () => {
      await useCase.execute({
        workerId: 'worker-1',
        documentType: 'resume_cv',
        externalUrl: 'https://x.com/f.pdf',
      });

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO domain_events'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).toContain("'worker.document.uploaded'");
      const payload = JSON.parse(insertCall[1][0]);
      expect(payload.workerId).toBe('worker-1');
      expect(payload.documentType).toBe('resume_cv');
      expect(payload.filePath).toContain('workers/worker-1/ingested/resume_cv');
      expect(payload.source).toBe('triage'); // default
      expect(payload.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(insertCall[1][1]).toBe('trace-1'); // traceId do ALS
    });

    it('respeita source explícito quando passado', async () => {
      await useCase.execute({
        workerId: 'worker-1',
        documentType: 'cv',
        externalUrl: 'https://x.com/f.pdf',
        source: 'admin',
      });

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO domain_events'),
      );
      const payload = JSON.parse(insertCall[1][0]);
      expect(payload.source).toBe('admin');
    });

    it('falha no emit do evento NÃO derruba o use case (best-effort)', async () => {
      mockPoolQuery.mockRejectedValue(new Error('DB unavailable'));

      const result = await useCase.execute({
        workerId: 'worker-1',
        documentType: 'cv',
        externalUrl: 'https://x.com/f.pdf',
      });

      // Use case retorna sucesso mesmo com emit falhando
      expect(result.workerId).toBe('worker-1');
      expect(result.filePath).toContain('workers/worker-1/ingested/cv');
    });

    it('NÃO emite evento quando worker não existe', async () => {
      mockFindById.mockResolvedValue(Result.ok(null));

      await expect(
        useCase.execute({ workerId: 'no-such', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
      ).rejects.toThrow(WorkerNotFoundError);

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO domain_events'),
      );
      expect(insertCall).toBeUndefined();
    });

    it('NÃO emite evento quando GCS falha', async () => {
      mockUploadBuffer.mockRejectedValue(new Error('GCS error'));

      await expect(
        useCase.execute({ workerId: 'worker-1', documentType: 'cv', externalUrl: 'https://x.com/f.pdf' }),
      ).rejects.toThrow(DownloadError);

      const insertCall = mockPoolQuery.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO domain_events'),
      );
      expect(insertCall).toBeUndefined();
    });
  });
});
