/**
 * WorkerDocumentsUploadCapability
 *
 * MCP write capability that downloads a document from an external URL
 * (e.g. Twilio/Chatwoot media) and persists it to GCS.
 *
 * SSRF defense is handled inside IngestDocumentFromUrlUseCase:
 *   1. hostname validated against ALLOWED_MEDIA_HOSTS allowlist
 *   2. resolved IP blocked for RFC 1918 / link-local / GCP metadata server
 */

import { z } from 'zod';
import type { IngestDocumentFromUrlUseCase } from '../../../worker/application/IngestDocumentFromUrlUseCase';
import type { IngestDocumentFromUrlResult } from '../../../worker/application/IngestDocumentFromUrlUseCase';

// ── Schemas ──────────────────────────────────────────────────────────────────

const DocumentTypeEnum = z.enum([
  'resume_cv',
  'identity_document',
  'identity_document_back',
  'criminal_record',
  'professional_registration',
  'liability_insurance',
  'monotributo_certificate',
  'at_certificate',
]);

const ArgsSchema = z.object({
  workerId:     z.string().uuid(),
  documentType: DocumentTypeEnum,
  mediaUrl:     z.string().url(),
});

export type WorkerDocumentsUploadArgs = z.infer<typeof ArgsSchema>;

// ── Capability ────────────────────────────────────────────────────────────────

export class WorkerDocumentsUploadCapability {
  static readonly NAME = 'worker.documents.upload';
  static readonly DESCRIPTION =
    'Upload a worker document from an external URL (e.g. Twilio/Chatwoot media). ' +
    'The URL is downloaded server-side, validated against host allowlist + IP allowlist ' +
    '(SSRF defense), and persisted to GCS.';
  static readonly INPUT_SHAPE = {
    workerId:     z.string().uuid(),
    documentType: DocumentTypeEnum,
    mediaUrl:     z.string().url(),
  };

  constructor(private readonly ingestUseCase: IngestDocumentFromUrlUseCase) {}

  async execute(args: unknown): Promise<IngestDocumentFromUrlResult> {
    const parsed = ArgsSchema.parse(args);

    return this.ingestUseCase.execute({
      workerId:     parsed.workerId,
      documentType: parsed.documentType,
      externalUrl:  parsed.mediaUrl,
    });
  }
}
