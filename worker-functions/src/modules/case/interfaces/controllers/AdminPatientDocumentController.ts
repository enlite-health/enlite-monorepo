import { Request, Response } from 'express';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { patientIdParamsSchema, patientDocumentIdParamsSchema, uploadDocumentBodySchema } from '../validators/patientPhotoSchemas';
import { UploadPatientDocumentUseCase, PatientDocumentTooLargeError } from '../../application/UploadPatientDocumentUseCase';
import { GetPatientDocumentUrlUseCase } from '../../application/GetPatientDocumentUrlUseCase';
import { InvalidDocumentImageError } from '../../infrastructure/stripJpegMetadata';

/**
 * AdminPatientDocumentController — prova documental de consentimento/revogação de imagem
 * (spec 018, PR-4, D329). Upload sempre pelo servidor (`multipart`); leitura sob a célula NOVA
 * `patient_consent_documents:read` (checada na ROTA, nunca aqui).
 */
export class AdminPatientDocumentController {
  constructor(
    private readonly uploadUseCase: UploadPatientDocumentUseCase = new UploadPatientDocumentUseCase(),
    private readonly getUrlUseCase: GetPatientDocumentUrlUseCase = new GetPatientDocumentUrlUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new Error('escrita exige ator identificado (lex C6)');
    return uid;
  }

  private async patientExists(id: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows.length > 0;
  }

  /** POST /api/admin/patients/:id/documents — multipart `file` (application/pdf ou image/jpeg) + campo `documentType`. */
  async upload(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = uploadDocumentBodySchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } }); return; }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) { res.status(400).json({ success: false, error: 'file é obrigatório (multipart)' }); return; }
    if (file.mimetype !== 'application/pdf' && file.mimetype !== 'image/jpeg') {
      res.status(415).json({ success: false, error: 'Content-Type não aceito (application/pdf ou image/jpeg)' });
      return;
    }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const result = await this.uploadUseCase.execute({
        patientId: params.data.id,
        buffer: file.buffer,
        contentType: file.mimetype,
        documentType: body.data.documentType,
        actorUid: this.actorUid(req),
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof PatientDocumentTooLargeError) { res.status(413).json({ success: false, error: err.message, code: 'DOCUMENT_TOO_LARGE' }); return; }
      if (err instanceof InvalidDocumentImageError) { res.status(422).json({ success: false, error: err.message, code: 'INVALID_DOCUMENT' }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientDocumentController:upload', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to upload document' });
    }
  }

  /** GET /api/admin/patients/:id/documents/:documentId — célula `patient_consent_documents:read` na rota. */
  async getUrl(req: Request, res: Response): Promise<void> {
    const params = patientDocumentIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const result = await this.getUrlUseCase.execute(params.data.id, params.data.documentId);
      if (!result) { res.status(404).json({ success: false, error: 'Document not found' }); return; }
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientDocumentController:getUrl', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to read document' });
    }
  }
}
