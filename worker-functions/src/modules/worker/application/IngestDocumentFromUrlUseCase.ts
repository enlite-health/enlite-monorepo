import { GCSStorageService } from '../infrastructure/GCSStorageService';
import { ExternalMediaDownloader } from '../infrastructure/ExternalMediaDownloader';
import { WorkerRepository } from '../infrastructure/WorkerRepository';
import { logger, reportError, loggingAls } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export type DocumentUploadSource = 'triage' | 'admin' | 'portal';

export interface IngestDocumentFromUrlInput {
  workerId: string;
  documentType: string;
  externalUrl: string;
  source?: DocumentUploadSource;
}

export interface IngestDocumentFromUrlResult {
  filePath: string;
  documentType: string;
  workerId: string;
}

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

/**
 * IngestDocumentFromUrlUseCase
 *
 * Faz download de documento externo (com SSRF defense) e faz upload para GCS.
 *
 * Erros semânticos lançados:
 *   - WorkerNotFoundError: worker não existe
 *   - HostBlockedError: host não está na allowlist / IP interno
 *   - FileTooLargeError: arquivo > 10MB
 *   - ContentTypeMismatchError: content-type não suportado
 *   - DownloadError: falha no download ou GCS
 */
export class WorkerNotFoundError extends Error {
  readonly code = 'WORKER_NOT_FOUND';
}

export class HostBlockedError extends Error {
  readonly code = 'HOST_BLOCKED';
}

export class FileTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE';
}

export class ContentTypeMismatchError extends Error {
  readonly code = 'CONTENT_TYPE_MISMATCH';
}

export class DownloadError extends Error {
  readonly code = 'DOWNLOAD_ERROR';
}

export class IngestDocumentFromUrlUseCase {
  private readonly workerRepo: WorkerRepository;
  private readonly downloader: ExternalMediaDownloader;
  private readonly storageService: GCSStorageService;

  constructor() {
    this.workerRepo = new WorkerRepository();
    this.downloader = new ExternalMediaDownloader();
    this.storageService = new GCSStorageService();
  }

  async execute(input: IngestDocumentFromUrlInput): Promise<IngestDocumentFromUrlResult> {
    const { workerId, documentType, externalUrl } = input;

    // Redact query string em logs
    const urlForLog = this.redactQueryString(externalUrl);
    const log = logger.child({
      workerId,
      documentType,
      url: urlForLog,
      useCase: 'IngestDocumentFromUrlUseCase',
    });

    log.info({ msg: 'starting document ingest' });

    // 1. Verificar que worker existe
    const workerResult = await this.workerRepo.findById(workerId);
    if (!workerResult.isSuccess || workerResult.getValue() === null) {
      throw new WorkerNotFoundError(`Worker not found: ${workerId}`);
    }

    // 2. Download com SSRF defense (lança HostBlockedError, FileTooLargeError)
    let buffer: Buffer;
    let contentType: string;
    try {
      const result = await this.downloader.download(externalUrl);
      buffer = result.buffer;
      contentType = result.contentType;
    } catch (err) {
      if (
        err instanceof HostBlockedError ||
        err instanceof FileTooLargeError
      ) {
        throw err;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'IngestDocumentFromUrlUseCase:download', workerId, url: urlForLog });
      throw new DownloadError(`Failed to download: ${e.message}`);
    }

    // 3. Validar content-type
    const baseType = contentType.split(';')[0].trim();
    if (!ALLOWED_CONTENT_TYPES.includes(baseType)) {
      throw new ContentTypeMismatchError(
        `Content-type not supported: ${baseType}`,
      );
    }

    // 4. Upload para GCS
    const filePath = `workers/${workerId}/ingested/${documentType}/${Date.now()}`;
    try {
      await this.storageService.uploadBuffer(buffer, filePath, baseType);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'IngestDocumentFromUrlUseCase:upload', workerId });
      throw new DownloadError(`GCS upload failed: ${e.message}`);
    }

    log.info({ msg: 'document ingested successfully', filePath });

    // TD-027: emit domain event pra extension points futuros (notification,
    // validation OCR, audit). Falha do emit não derruba o upload — o doc já
    // foi persistido com sucesso, evento é best-effort.
    await this.emitUploadedEvent({
      workerId,
      documentType,
      filePath,
      source: input.source ?? 'triage',
    });

    return { filePath, documentType, workerId };
  }

  private async emitUploadedEvent(params: {
    workerId: string;
    documentType: string;
    filePath: string;
    source: DocumentUploadSource;
  }): Promise<void> {
    try {
      const pool = DatabaseConnection.getInstance().getPool();
      const traceId = loggingAls.getStore()?.traceId ?? null;
      await pool.query(
        `INSERT INTO domain_events (event, payload, trace_id) VALUES ('worker.document.uploaded', $1::jsonb, $2)`,
        [
          JSON.stringify({
            workerId: params.workerId,
            documentType: params.documentType,
            filePath: params.filePath,
            source: params.source,
            uploadedAt: new Date().toISOString(),
          }),
          traceId,
        ],
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Best-effort: log mas não falha o use case
      logger.warn(
        { err: e.message, workerId: params.workerId },
        'failed to emit worker.document.uploaded event',
      );
      reportError(e, {
        source: 'IngestDocumentFromUrlUseCase:emitUploadedEvent',
        workerId: params.workerId,
      });
    }
  }

  private redactQueryString(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      return parsed.toString();
    } catch {
      return '[invalid-url]';
    }
  }
}
