import { Request, Response } from 'express';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { patientIdParamsSchema, patientConsentIdParamsSchema, registerImageConsentSchema, revokeImageConsentSchema } from '../validators/patientPhotoSchemas';
import {
  RegisterImageConsentUseCase,
  ImageConsentAlreadyActiveError,
  ImageConsentReferenceNotFoundError,
  RepresentativeRequiredError,
} from '../../application/RegisterImageConsentUseCase';
import { RevokeImageConsentUseCase } from '../../application/RevokeImageConsentUseCase';
import { GetVigenteImageConsentUseCase } from '../../application/GetVigenteImageConsentUseCase';
import { PatientPhotoBucketNotConfiguredError } from '../../infrastructure/PatientPhotoStorage';
import { patientExistsCheck } from './patientExistsCheck';

/**
 * AdminPatientImageConsentController — registro/revogação do consentimento de imagem
 * (spec 018, PR-4). Decisão 14/09 (D335): registrar é OPCIONAL — esta rota existe para quem
 * QUER deixar o registro, nunca é pré-requisito de outra rota.
 */
export class AdminPatientImageConsentController {
  constructor(
    private readonly registerUseCase: RegisterImageConsentUseCase = new RegisterImageConsentUseCase(),
    private readonly revokeUseCase: RevokeImageConsentUseCase = new RevokeImageConsentUseCase(),
    private readonly getVigenteUseCase: GetVigenteImageConsentUseCase = new GetVigenteImageConsentUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new Error('escrita exige ator identificado (lex C6)');
    return uid;
  }

  // Achado da revisão do PR-4 (item 5): reusa `patientExistsCheck` em vez de nascer com mais uma cópia.
  private async patientExists(id: string): Promise<boolean> {
    return patientExistsCheck(this.db, id);
  }

  /** POST /api/admin/patients/:id/image-consents */
  async register(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = registerImageConsentSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const result = await this.registerUseCase.execute(params.data.id, body.data, this.actorUid(req));
      res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof ImageConsentAlreadyActiveError) { res.status(409).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof RepresentativeRequiredError) { res.status(422).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof ImageConsentReferenceNotFoundError) { res.status(404).json({ success: false, error: err.message, code: err.code }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientImageConsentController:register', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to register consent' });
    }
  }

  /**
   * GET /api/admin/patients/:id/image-consents/vigente — furo fechado nesta rodada: `findVigente`
   * já existia no repositório, sem rota. `data: null` quando não há consentimento vigente (nunca
   * registrado, ou revogado). Célula `patient_identity:read` (mesma da rota — sem célula nova).
   */
  async getVigente(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const result = await this.getVigenteUseCase.execute(params.data.id);
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientImageConsentController:getVigente', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to read consent' });
    }
  }

  /** POST /api/admin/patients/:id/image-consents/:cid/revoke — apaga a foto na mesma operação. */
  async revoke(req: Request, res: Response): Promise<void> {
    const params = patientConsentIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = revokeImageConsentSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const { revoked } = await this.revokeUseCase.execute(params.data.id, params.data.cid, body.data, this.actorUid(req));
      if (!revoked) { res.status(404).json({ success: false, error: 'Consent not found' }); return; }
      res.status(200).json({ success: true, data: { id: params.data.cid, revoked: true } });
    } catch (err: unknown) {
      // Achado da revisão do PR-4 (item 1): revogar apaga a foto na mesma operação — sem
      // GCS_PATIENT_PHOTOS_BUCKET só ESTA rota falha, com 503 (não 500).
      if (err instanceof PatientPhotoBucketNotConfiguredError) { res.status(503).json({ success: false, error: 'Photo storage not configured', code: 'PHOTO_STORAGE_NOT_CONFIGURED' }); return; }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientImageConsentController:revoke', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to revoke consent' });
    }
  }
}
