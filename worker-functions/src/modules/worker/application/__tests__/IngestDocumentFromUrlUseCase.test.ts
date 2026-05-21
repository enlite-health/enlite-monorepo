/**
 * IngestDocumentFromUrlUseCase.test.ts
 */
import { Result } from '@shared/utils/Result';

const mockFindById = jest.fn();
const mockDownload = jest.fn();
const mockUploadBuffer = jest.fn();

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

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
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
});
