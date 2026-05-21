import { WorkerDocumentsUploadCapability } from '../WorkerDocumentsUploadCapability';
import type { IngestDocumentFromUrlUseCase } from '@modules/worker/application/IngestDocumentFromUrlUseCase';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';
const MEDIA_URL = 'https://media.twilio.com/v1/messages/ME123/Media/ME456';

const INGEST_RESULT = {
  filePath: `workers/${WORKER_ID}/ingested/resume_cv/1234567890`,
  documentType: 'resume_cv',
  workerId: WORKER_ID,
};

function makeIngestUseCase(
  result?: typeof INGEST_RESULT,
  throws?: Error,
): jest.Mocked<Pick<IngestDocumentFromUrlUseCase, 'execute'>> {
  return {
    execute: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(result ?? INGEST_RESULT),
  };
}

function makeCap(
  useCase: jest.Mocked<Pick<IngestDocumentFromUrlUseCase, 'execute'>>,
): WorkerDocumentsUploadCapability {
  return new WorkerDocumentsUploadCapability(
    useCase as unknown as IngestDocumentFromUrlUseCase,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WorkerDocumentsUploadCapability', () => {
  beforeEach(() => jest.clearAllMocks());

  // Static metadata
  it('NAME is worker.documents.upload', () => {
    expect(WorkerDocumentsUploadCapability.NAME).toBe('worker.documents.upload');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerDocumentsUploadCapability.DESCRIPTION).toBe('string');
    expect(WorkerDocumentsUploadCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId, documentType and mediaUrl', () => {
    expect(WorkerDocumentsUploadCapability.INPUT_SHAPE).toHaveProperty('workerId');
    expect(WorkerDocumentsUploadCapability.INPUT_SHAPE).toHaveProperty('documentType');
    expect(WorkerDocumentsUploadCapability.INPUT_SHAPE).toHaveProperty('mediaUrl');
  });

  // 1. Happy path — useCase called with externalUrl=mediaUrl
  it('happy path: calls ingestUseCase with externalUrl mapped from mediaUrl', async () => {
    const ingest = makeIngestUseCase();
    const cap = makeCap(ingest);

    const result = await cap.execute({
      workerId: WORKER_ID,
      documentType: 'resume_cv',
      mediaUrl: MEDIA_URL,
    });

    expect(ingest.execute).toHaveBeenCalledWith({
      workerId: WORKER_ID,
      documentType: 'resume_cv',
      externalUrl: MEDIA_URL,
    });
    expect(result).toEqual(INGEST_RESULT);
  });

  // 2. Invalid documentType → Zod error
  it('invalid documentType is rejected by Zod', async () => {
    const ingest = makeIngestUseCase();
    const cap = makeCap(ingest);

    await expect(
      cap.execute({ workerId: WORKER_ID, documentType: 'unknown_doc', mediaUrl: MEDIA_URL }),
    ).rejects.toThrow();
    expect(ingest.execute).not.toHaveBeenCalled();
  });

  // 3. mediaUrl not a URL → Zod error
  it('mediaUrl that is not a URL is rejected by Zod', async () => {
    const ingest = makeIngestUseCase();
    const cap = makeCap(ingest);

    await expect(
      cap.execute({ workerId: WORKER_ID, documentType: 'resume_cv', mediaUrl: 'not-a-url' }),
    ).rejects.toThrow();
    expect(ingest.execute).not.toHaveBeenCalled();
  });

  // 4. UseCase failure (SSRF blocked, etc.) propagates
  it('propagates error from ingest use case (e.g. SSRF blocked)', async () => {
    const ingest = makeIngestUseCase(undefined, new Error('HOST_BLOCKED'));
    const cap = makeCap(ingest);

    await expect(
      cap.execute({ workerId: WORKER_ID, documentType: 'criminal_record', mediaUrl: MEDIA_URL }),
    ).rejects.toThrow('HOST_BLOCKED');
  });

  // 5. UseCase return value is passed through as-is
  it('passes through the exact return value from ingest use case', async () => {
    const customResult = {
      filePath: 'workers/abc/ingested/at_certificate/999',
      documentType: 'at_certificate',
      workerId: WORKER_ID,
    };
    const ingest = makeIngestUseCase(customResult);
    const cap = makeCap(ingest);

    const result = await cap.execute({
      workerId: WORKER_ID,
      documentType: 'at_certificate',
      mediaUrl: MEDIA_URL,
    });

    expect(result).toEqual(customResult);
  });

  // 6. All valid documentType values are accepted
  it.each([
    'resume_cv',
    'identity_document',
    'identity_document_back',
    'criminal_record',
    'professional_registration',
    'liability_insurance',
    'monotributo_certificate',
    'at_certificate',
  ])('documentType "%s" is accepted', async (docType) => {
    const ingest = makeIngestUseCase({
      filePath: `workers/${WORKER_ID}/ingested/${docType}/0`,
      documentType: docType,
      workerId: WORKER_ID,
    });
    const cap = makeCap(ingest);

    await expect(
      cap.execute({ workerId: WORKER_ID, documentType: docType, mediaUrl: MEDIA_URL }),
    ).resolves.toMatchObject({ documentType: docType });
  });
});
