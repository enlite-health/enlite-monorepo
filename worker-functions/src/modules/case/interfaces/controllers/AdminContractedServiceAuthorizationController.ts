import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { ContractedServiceAuthorizationRepository } from '../../infrastructure/ContractedServiceAuthorizationRepository';
import { AuthorizationNotFoundError, AuthorizationOverlapsError } from '../../domain/ContractedServiceAuthorization';
import { authorizationBodySchema } from '../validators/contractedServiceAuthorizationSchemas';

const serviceParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
const authorizationParamsSchema = serviceParamsSchema.extend({ aid: z.string().uuid() });

/**
 * AdminContractedServiceAuthorizationController — horas autorizadas do serviço, com vigência (spec 056 §5.2).
 *
 *   GET  /api/admin/patients/:id/contracted-services/:sid/authorizations              (patient_services:read)
 *   POST /api/admin/patients/:id/contracted-services/:sid/authorizations              (patient_services:update)
 *   POST /api/admin/patients/:id/contracted-services/:sid/authorizations/:aid/supersede (patient_services:update)
 *
 * Sem DELETE. `validTo` é inclusivo na API. Erros: zod 400 · validTo null 422 · sobreposição 409 · serviço alheio 404.
 */
export class AdminContractedServiceAuthorizationController {
  constructor(private readonly repo: ContractedServiceAuthorizationRepository = new ContractedServiceAuthorizationRepository()) {}

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  async list(req: Request, res: Response): Promise<void> {
    const params = serviceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      if (!(await this.repo.serviceBelongsToPatient(params.data.id, params.data.sid))) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      const authorizations = await this.repo.list(params.data.sid);
      res.status(200).json({ success: true, data: { authorizations } });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), {
        source: 'AdminContractedServiceAuthorizationController:list', patientId: params.data.id, serviceId: params.data.sid,
      });
      res.status(500).json({ success: false, error: 'Failed to list authorizations' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    const params = serviceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    await this.write(req, res, params.data.id, params.data.sid, null);
  }

  async supersede(req: Request, res: Response): Promise<void> {
    const params = authorizationParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    await this.write(req, res, params.data.id, params.data.sid, params.data.aid);
  }

  private async write(req: Request, res: Response, patientId: string, serviceId: string, supersedes: string | null): Promise<void> {
    const body = authorizationBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    if (body.data.validTo === null) {
      res.status(422).json({ success: false, error: 'authorization needs an end date', code: 'AUTHORIZATION_NEEDS_END' });
      return;
    }
    const source = `AdminContractedServiceAuthorizationController:${supersedes ? 'supersede' : 'create'}`;
    try {
      if (!(await this.repo.serviceBelongsToPatient(patientId, serviceId))) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      const w = { serviceId, hours: body.data.hours, validFrom: body.data.validFrom, validTo: body.data.validTo, actorUid: this.actorUid(req) };
      const view = supersedes ? await this.repo.supersede(supersedes, w) : await this.repo.create(w);
      res.status(201).json({ success: true, data: view });
    } catch (err: unknown) {
      if (err instanceof AuthorizationOverlapsError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof AuthorizationNotFoundError) {
        res.status(404).json({ success: false, error: err.message, code: err.code });
        return;
      }
      reportError(err instanceof Error ? err : new Error(String(err)), { source, patientId, serviceId });
      res.status(500).json({ success: false, error: 'Failed to write authorization' });
    }
  }
}
