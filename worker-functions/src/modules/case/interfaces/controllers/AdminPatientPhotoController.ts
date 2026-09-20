import { Request, Response } from 'express';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { patientIdParamsSchema } from '../validators/patientPhotoSchemas';
import { UploadPatientPhotoUseCase } from '../../application/UploadPatientPhotoUseCase';
import { DeletePatientPhotoUseCase } from '../../application/DeletePatientPhotoUseCase';
import { GetPatientPhotoUrlUseCase } from '../../application/GetPatientPhotoUrlUseCase';
import { InvalidPatientPhotoError, PatientPhotoTooLargeError } from '../../infrastructure/PatientPhotoProcessor';
import { PatientPhotoBucketNotConfiguredError } from '../../infrastructure/PatientPhotoStorage';
import { patientExistsCheck } from './patientExistsCheck';

/**
 * AdminPatientPhotoController — foto de perfil do paciente (spec 018, PR-4; `lex` #1).
 * Decisão 14/09 (D335): sem checagem de consentimento/representante — upload sempre aceito
 * (sujeito só a validação de arquivo: tamanho/formato).
 */
export class AdminPatientPhotoController {
  constructor(
    private readonly uploadUseCase: UploadPatientPhotoUseCase = new UploadPatientPhotoUseCase(),
    private readonly deleteUseCase: DeletePatientPhotoUseCase = new DeletePatientPhotoUseCase(),
    private readonly getUrlUseCase: GetPatientPhotoUrlUseCase = new GetPatientPhotoUrlUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new Error('escrita exige ator identificado (lex C6)');
    return uid;
  }

  // Achado da revisão do PR-4 (item 5): reusa `patientExistsCheck` (nenhum helper compartilhado
  // pré-existia no módulo — ver o comentário do arquivo) em vez de nascer com mais uma cópia.
  private async patientExists(id: string): Promise<boolean> {
    return patientExistsCheck(this.db, id);
  }

  /** POST /api/admin/patients/:id/photo — multipart `file` (image/jpeg ou image/png, ≤5MB). */
  async upload(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) { res.status(400).json({ success: false, error: 'file é obrigatório (multipart)' }); return; }
    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
      res.status(415).json({ success: false, error: 'Content-Type não aceito (image/jpeg ou image/png)' });
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
        actorUid: this.actorUid(req),
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof PatientPhotoTooLargeError) { res.status(413).json({ success: false, error: err.message, code: 'PHOTO_TOO_LARGE' }); return; }
      if (err instanceof InvalidPatientPhotoError) { res.status(422).json({ success: false, error: err.message, code: 'INVALID_PHOTO' }); return; }
      // Achado da revisão do PR-4 (item 1): sem GCS_PATIENT_PHOTOS_BUCKET só ESTA rota falha —
      // 503 (indisponível), não 500 (erro interno) — é config faltando, não bug.
      if (err instanceof PatientPhotoBucketNotConfiguredError) { res.status(503).json({ success: false, error: 'Photo storage not configured', code: 'PHOTO_STORAGE_NOT_CONFIGURED' }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientPhotoController:upload', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to upload photo' });
    }
  }

  /** DELETE /api/admin/patients/:id/photo */
  async remove(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const { deleted } = await this.deleteUseCase.execute(params.data.id);
      if (!deleted) { res.status(404).json({ success: false, error: 'Photo not found' }); return; }
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof PatientPhotoBucketNotConfiguredError) { res.status(503).json({ success: false, error: 'Photo storage not configured', code: 'PHOTO_STORAGE_NOT_CONFIGURED' }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientPhotoController:remove', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to delete photo' });
    }
  }

  /** GET /api/admin/patients/:id/photo — URL assinada v4, 300s. Célula `patient_identity:read` na rota. */
  async getUrl(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const result = await this.getUrlUseCase.execute(params.data.id);
      if (!result) { res.status(404).json({ success: false, error: 'Photo not found' }); return; }
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof PatientPhotoBucketNotConfiguredError) { res.status(503).json({ success: false, error: 'Photo storage not configured', code: 'PHOTO_STORAGE_NOT_CONFIGURED' }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientPhotoController:getUrl', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to read photo' });
    }
  }
}
