import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { actorUid, MissingActorError } from '@modules/conversation/interfaces/controllers/ConversationActor';
import { AttachmentRejectedError } from '@modules/conversation/application/UploadConversationAttachmentUseCase';
import { ListPatientDocumentsUseCase } from '../../application/ListPatientDocumentsUseCase';
import { UploadPatientDocumentUseCase } from '../../application/UploadPatientDocumentUseCase';
import { RenamePatientDocumentUseCase } from '../../application/RenamePatientDocumentUseCase';
import { DeletePatientDocumentUseCase } from '../../application/DeletePatientDocumentUseCase';
import { GetPatientDocumentUrlUseCase } from '../../application/GetPatientDocumentUrlUseCase';
import {
  InvalidDocumentLabelError,
  PatientDocumentNotFoundError,
  PatientNotFoundError,
} from '../../domain/PatientDocument';

/**
 * PatientDocumentsController — aba "Documentos" da ficha (spec 031). `:id` é SEMPRE o patient id.
 *
 * Erros de domínio carregam `status`/`code` próprios e viram resposta direto; qualquer outro vira
 * 500 genérico, relatado SÓ com o UUID do paciente (nunca nome de arquivo, rótulo ou caminho).
 * 404 vale para paciente inexistente/de outro país (RLS) e para `docId` de outro paciente — a
 * resposta não distingue as causas.
 */
const patientParams = z.object({ id: z.string().uuid() });
const documentParams = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
const renameBody = z.object({ label: z.unknown() });

type DomainError =
  | InvalidDocumentLabelError
  | PatientDocumentNotFoundError
  | PatientNotFoundError
  | AttachmentRejectedError
  | MissingActorError;

function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof InvalidDocumentLabelError ||
    err instanceof PatientDocumentNotFoundError ||
    err instanceof PatientNotFoundError ||
    err instanceof AttachmentRejectedError ||
    err instanceof MissingActorError
  );
}

export class PatientDocumentsController {
  constructor(
    private readonly listUseCase: ListPatientDocumentsUseCase = new ListPatientDocumentsUseCase(),
    private readonly uploadUseCase: UploadPatientDocumentUseCase = new UploadPatientDocumentUseCase(),
    private readonly renameUseCase: RenamePatientDocumentUseCase = new RenamePatientDocumentUseCase(),
    private readonly deleteUseCase: DeletePatientDocumentUseCase = new DeletePatientDocumentUseCase(),
    private readonly urlUseCase: GetPatientDocumentUrlUseCase = new GetPatientDocumentUrlUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /** GET /api/admin/patients/:id/documents — `patient_document:read`. */
  async list(req: Request, res: Response): Promise<void> {
    const params = patientParams.safeParse(req.params);
    if (!params.success) { this.invalid(res); return; }
    await this.run(res, 'list', params.data.id, async () => {
      res.status(200).json({ success: true, data: await this.listUseCase.execute(this.db, params.data.id) });
    });
  }

  /** POST /api/admin/patients/:id/documents — multipart `file` + `label`, `patient_document:create`. */
  async upload(req: Request, res: Response): Promise<void> {
    const params = patientParams.safeParse(req.params);
    if (!params.success) { this.invalid(res); return; }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) { res.status(400).json({ success: false, error: 'file é obrigatório (multipart)' }); return; }

    await this.run(res, 'upload', params.data.id, async () => {
      const created = await this.uploadUseCase.execute(this.db, {
        patientId: params.data.id,
        actorUid: actorUid(req),
        buffer: file.buffer,
        originalFilename: file.originalname,
        label: (req.body as { label?: unknown } | undefined)?.label,
      });
      res.status(201).json({ success: true, data: created });
    });
  }

  /** PATCH /api/admin/patients/:id/documents/:docId — {label}, `patient_document:update`. */
  async rename(req: Request, res: Response): Promise<void> {
    const params = documentParams.safeParse(req.params);
    const body = renameBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) { this.invalid(res); return; }
    await this.run(res, 'rename', params.data.id, async () => {
      const updated = await this.renameUseCase.execute(this.db, {
        patientId: params.data.id,
        docId: params.data.docId,
        actorUid: actorUid(req),
        label: body.data.label,
      });
      res.status(200).json({ success: true, data: updated });
    });
  }

  /** DELETE /api/admin/patients/:id/documents/:docId — `patient_document:delete`. */
  async remove(req: Request, res: Response): Promise<void> {
    const params = documentParams.safeParse(req.params);
    if (!params.success) { this.invalid(res); return; }
    await this.run(res, 'remove', params.data.id, async () => {
      await this.deleteUseCase.execute(this.db, { patientId: params.data.id, docId: params.data.docId });
      res.status(204).end();
    });
  }

  /** GET /api/admin/patients/:id/documents/:docId/url — `patient_document:read`. */
  async getUrl(req: Request, res: Response): Promise<void> {
    const params = documentParams.safeParse(req.params);
    if (!params.success) { this.invalid(res); return; }
    await this.run(res, 'getUrl', params.data.id, async () => {
      const result = await this.urlUseCase.execute(this.db, { patientId: params.data.id, docId: params.data.docId });
      if (!result) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
      res.status(200).json({ success: true, data: result });
    });
  }

  private invalid(res: Response): void {
    res.status(400).json({ success: false, error: 'Invalid params' });
  }

  private async run(res: Response, source: string, patientId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      if (isDomainError(err)) {
        res.status(err.status).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `PatientDocumentsController:${source}`, patientId });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
