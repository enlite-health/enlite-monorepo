import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { UploadConversationAttachmentUseCase, AttachmentRejectedError } from '../../application/UploadConversationAttachmentUseCase';
import { GetConversationAttachmentUrlUseCase } from '../../application/GetConversationAttachmentUrlUseCase';
import { resolveConversationForPatient } from './resolveConversationForPatient';
import { MissingActorError, actorUid } from './ConversationActor';

/**
 * AdminConversationAttachmentController — spec 022, Bloco 3 (T311/T312, T314/T315). Arquivo
 * SEPARADO de `AdminConversationController.ts` (mensagens) pelo mesmo motivo que
 * `AdminPatientPhotoController.ts` é separado de `AdminPatientsController` — teto de 400 linhas
 * do módulo, e é uma responsabilidade fatiada por si (upload/download de arquivo, não mensagem).
 *
 * `:id` na URL é sempre o PATIENT id (mesmo contrato de `AdminConversationController`) —
 * `resolveConversationForPatient` traduz para o `conversationId`.
 */
const patientIdParamsSchema = z.object({ id: z.string().uuid() });
const fileIdParamsSchema = z.object({ id: z.string().uuid(), fileId: z.string().uuid() });

export class AdminConversationAttachmentController {
  constructor(
    private readonly uploadUseCase: UploadConversationAttachmentUseCase = new UploadConversationAttachmentUseCase(),
    private readonly getUrlUseCase: GetConversationAttachmentUrlUseCase = new GetConversationAttachmentUrlUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /** POST /api/admin/patients/:id/conversation/files — multipart `file`, célula `patient_conversation:create`. */
  async upload(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) { res.status(400).json({ success: false, error: 'file é obrigatório (multipart)' }); return; }

    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }

      const result = await this.uploadUseCase.execute(this.db, {
        conversationId: lookup.conversationId,
        actorUid: actorUid(req),
        buffer: file.buffer,
        originalFilename: file.originalname,
      });
      res.status(201).json({ success: true, data: { fileId: result.fileId } });
    } catch (err: unknown) {
      if (err instanceof AttachmentRejectedError) {
        res.status(err.status).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'upload', params.data.id);
    }
  }

  /** GET /api/admin/patients/:id/conversation/files/:fileId/url — célula `patient_conversation:read`. */
  async getUrl(req: Request, res: Response): Promise<void> {
    const params = fileIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }

      const result = await this.getUrlUseCase.execute(this.db, { patientId: params.data.id, fileId: params.data.fileId });
      if (!result) { res.status(404).json({ success: false, error: 'File not found' }); return; }
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleUnexpected(err, res, 'getUrl', params.data.id);
    }
  }

  private handleUnexpected(err: unknown, res: Response, source: string, patientId: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminConversationAttachmentController:${source}`, patientId });
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}
