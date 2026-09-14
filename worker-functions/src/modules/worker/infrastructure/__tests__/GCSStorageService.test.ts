const mockFile = {
  getSignedUrl: jest.fn(),
  delete: jest.fn(),
  save: jest.fn(),
};
const mockBucket = { file: jest.fn().mockReturnValue(mockFile) };
const mockStorage = { bucket: jest.fn().mockReturnValue(mockBucket) };

jest.mock('firebase-admin', () => ({
  storage: jest.fn(() => mockStorage),
}));

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));

import { GCSStorageService } from '../GCSStorageService';

const ORIGINAL_ENV = { ...process.env };

function buildRealModeService(bucketName = 'enlite-worker-documents'): GCSStorageService {
  process.env.NODE_ENV = 'production';
  process.env.GCP_PROJECT_ID = 'enlite-prd';
  process.env.DISABLE_GCS_MOCK = 'true';
  process.env.GCS_BUCKET_NAME = bucketName;
  return new GCSStorageService();
}

function buildMockModeService(): GCSStorageService {
  process.env.NODE_ENV = 'development';
  delete process.env.GCP_PROJECT_ID;
  delete process.env.DISABLE_GCS_MOCK;
  delete process.env.GCS_BUCKET_NAME;
  return new GCSStorageService();
}

describe('GCSStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  describe('getBucketName', () => {
    it('usa o default quando GCS_BUCKET_NAME não está setada', () => {
      delete process.env.GCS_BUCKET_NAME;
      const svc = new GCSStorageService();
      expect(svc.getBucketName()).toBe('enlite-worker-documents');
    });

    it('usa GCS_BUCKET_NAME quando setada', () => {
      process.env.GCS_BUCKET_NAME = 'meu-bucket';
      const svc = new GCSStorageService();
      expect(svc.getBucketName()).toBe('meu-bucket');
    });
  });

  describe('modo mock (dev/test sem credenciais GCP)', () => {
    it('generateUploadSignedUrl retorna URL simulada', async () => {
      const svc = buildMockModeService();
      const result = await svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/pdf');
      expect(result.filePath).toMatch(/^workers\/worker-1\/identity_document\/.+\.pdf$/);
      expect(result.signedUrl).toContain('mock-gcs-upload');
    });

    it('generateAdditionalUploadSignedUrl retorna URL simulada', async () => {
      const svc = buildMockModeService();
      const result = await svc.generateAdditionalUploadSignedUrl('worker-1', 'image/png');
      expect(result.filePath).toMatch(/^workers\/worker-1\/additional\/.+\.png$/);
    });

    it('generateUploadSignedUrl sem contentType usa o default application/pdf', async () => {
      const svc = buildMockModeService();
      const result = await svc.generateUploadSignedUrl('worker-1', 'identity_document');
      expect(result.filePath).toMatch(/\.pdf$/);
    });

    it('generateAdditionalUploadSignedUrl sem contentType usa o default application/pdf', async () => {
      const svc = buildMockModeService();
      const result = await svc.generateAdditionalUploadSignedUrl('worker-1');
      expect(result.filePath).toMatch(/\.pdf$/);
    });

    it('signUpload usa extensão default (pdf) para content-type desconhecido', async () => {
      const svc = buildMockModeService();
      const result = await svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/octet-stream');
      expect(result.filePath).toMatch(/\.pdf$/);
    });

    it('generateViewSignedUrl retorna URL simulada', async () => {
      const svc = buildMockModeService();
      const signedUrl = await svc.generateViewSignedUrl('workers/worker-1/identity_document/x.pdf');
      expect(signedUrl).toContain('mock-gcs-view');
    });

    it('deleteFile apenas loga, não chama GCS real', async () => {
      const svc = buildMockModeService();
      await svc.deleteFile('workers/worker-1/identity_document/x.pdf');
      expect(mockFile.delete).not.toHaveBeenCalled();
    });

    it('uploadBuffer apenas loga, não chama GCS real', async () => {
      const svc = buildMockModeService();
      await svc.uploadBuffer(Buffer.from('x'), 'workers/worker-1/x.pdf', 'application/pdf');
      expect(mockFile.save).not.toHaveBeenCalled();
    });

    it('DISABLE_GCS_MOCK=true força modo real mesmo em dev sem credenciais', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.GCP_PROJECT_ID;
      process.env.DISABLE_GCS_MOCK = 'true';
      mockFile.getSignedUrl.mockResolvedValue(['https://real-signed-url']);
      const svc = new GCSStorageService();
      return svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/pdf').then((r) => {
        expect(r.signedUrl).toBe('https://real-signed-url');
      });
    });
  });

  describe('modo real (produção / GCP_PROJECT_ID setado)', () => {
    it('signUpload chama getSignedUrl com action write e retorna a URL real', async () => {
      mockFile.getSignedUrl.mockResolvedValue(['https://real-upload-url']);
      const svc = buildRealModeService();
      const result = await svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/pdf');
      expect(mockBucket.file).toHaveBeenCalledWith(expect.stringMatching(/^workers\/worker-1\/identity_document\/.+\.pdf$/));
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', action: 'write' }));
      expect(result.signedUrl).toBe('https://real-upload-url');
    });

    it('signUpload propaga erro como mensagem amigável quando getSignedUrl falha', async () => {
      mockFile.getSignedUrl.mockRejectedValue(new Error('permission denied'));
      const svc = buildRealModeService();
      await expect(svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/pdf'))
        .rejects.toThrow('Failed to generate signed URL: permission denied');
    });

    it('signUpload propaga mensagem genérica quando o erro não é Error', async () => {
      mockFile.getSignedUrl.mockRejectedValue('boom');
      const svc = buildRealModeService();
      await expect(svc.generateUploadSignedUrl('worker-1', 'identity_document', 'application/pdf'))
        .rejects.toThrow('Failed to generate signed URL: Unknown error');
    });

    it('generateViewSignedUrl resolve o path relativo de uma URL completa do MESMO bucket e assina leitura', async () => {
      mockFile.getSignedUrl.mockResolvedValue(['https://real-view-url']);
      const svc = buildRealModeService('enlite-worker-documents');
      const fullUrl = 'https://storage.googleapis.com/enlite-worker-documents/workers/w1/identity_document/x.pdf?sig=abc';
      const signedUrl = await svc.generateViewSignedUrl(fullUrl);
      expect(mockBucket.file).toHaveBeenCalledWith('workers/w1/identity_document/x.pdf');
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', action: 'read' }));
      expect(signedUrl).toBe('https://real-view-url');
    });

    it('generateViewSignedUrl usa o path já relativo quando não tem prefixo de URL', async () => {
      mockFile.getSignedUrl.mockResolvedValue(['https://real-view-url']);
      const svc = buildRealModeService();
      await svc.generateViewSignedUrl('workers/w1/identity_document/x.pdf');
      expect(mockBucket.file).toHaveBeenCalledWith('workers/w1/identity_document/x.pdf');
    });

    it('generateViewSignedUrl propaga erro amigável quando getSignedUrl falha', async () => {
      mockFile.getSignedUrl.mockRejectedValue(new Error('not found'));
      const svc = buildRealModeService();
      await expect(svc.generateViewSignedUrl('workers/w1/x.pdf'))
        .rejects.toThrow('Failed to generate view signed URL: not found');
    });

    it('generateViewSignedUrl propaga mensagem genérica quando o erro não é Error', async () => {
      mockFile.getSignedUrl.mockRejectedValue('boom');
      const svc = buildRealModeService();
      await expect(svc.generateViewSignedUrl('workers/w1/x.pdf'))
        .rejects.toThrow('Failed to generate view signed URL: Unknown error');
    });

    it('deleteFile resolve o path relativo e chama file.delete com ignoreNotFound', async () => {
      mockFile.delete.mockResolvedValue(undefined);
      const svc = buildRealModeService('enlite-worker-documents');
      const fullUrl = 'https://storage.googleapis.com/enlite-worker-documents/workers/w1/x.pdf';
      await svc.deleteFile(fullUrl);
      expect(mockBucket.file).toHaveBeenCalledWith('workers/w1/x.pdf');
      expect(mockFile.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    });

    it('uploadBuffer salva o buffer com o content-type informado', async () => {
      mockFile.save.mockResolvedValue(undefined);
      const svc = buildRealModeService();
      await svc.uploadBuffer(Buffer.from('conteudo'), 'workers/w1/x.pdf', 'application/pdf');
      expect(mockFile.save).toHaveBeenCalledWith(
        Buffer.from('conteudo'),
        expect.objectContaining({ metadata: { contentType: 'application/pdf' }, resumable: false }),
      );
    });

    it('uploadBuffer propaga erro amigável quando save falha', async () => {
      mockFile.save.mockRejectedValue(new Error('quota exceeded'));
      const svc = buildRealModeService();
      await expect(svc.uploadBuffer(Buffer.from('x'), 'workers/w1/x.pdf', 'application/pdf'))
        .rejects.toThrow('Failed to upload buffer to GCS: quota exceeded');
    });

    it('uploadBuffer propaga mensagem genérica quando o erro não é Error', async () => {
      mockFile.save.mockRejectedValue('boom');
      const svc = buildRealModeService();
      await expect(svc.uploadBuffer(Buffer.from('x'), 'workers/w1/x.pdf', 'application/pdf'))
        .rejects.toThrow('Failed to upload buffer to GCS: Unknown error');
    });
  });
});
