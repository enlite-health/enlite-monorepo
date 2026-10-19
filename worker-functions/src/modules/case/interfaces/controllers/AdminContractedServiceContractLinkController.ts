import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { hourlyValueActorOf, projectContractedServiceForActor } from '../../application/contractedServiceHourlyValueAccess';
import { PatientContractedServiceRepository } from '../../infrastructure/PatientContractedServiceRepository';
import { ContractedServiceContractLinkWriter } from '../../infrastructure/contractedServiceContractLinkWriter';
import {
  createContractLinkSchema,
  endContractLinkSchema,
  supersedeContractLinkSchema,
  linkParamsSchema,
} from '../validators/contractLinkSchemas';
import { respondInsuranceError } from './insuranceErrorResponse';

/**
 * AdminContractedServiceContractLinkController — o vínculo do serviço contratado ao contrato da obra social (spec 058 §3.2 §E).
 * Célula das três rotas: `patient_services:update`.
 *
 *   POST /api/admin/patients/:id/contracted-services/:sid/contract-link            — vínculo novo (201)
 *   POST /api/admin/patients/:id/contracted-services/:sid/contract-link/end        — encerra o vivo (200)
 *   POST /api/admin/patients/:id/contracted-services/:sid/contract-link/supersede  — troca (SWITCHED) ou corrige (CORRECTION) (200)
 *
 * A resposta é o SERVIÇO inteiro, projetado para o ator (`projectContractedServiceForActor`: preço e nomes do pagador redigidos por célula),
 * com `asOf` do país do serviço a partir de UM `requestNow` por requisição. Erros do banco (`REQUIRES_NEW_SERVICE`, `USE_CORRECTION`,
 * `TWO_PAYERS_OVERLAP`, `COUNTRY_MISMATCH`, 23P01, 40P01) saem por `insuranceErrorResponse`. Nada do corpo vai para log.
 */
export class AdminContractedServiceContractLinkController {
  constructor(
    private readonly writer: ContractedServiceContractLinkWriter = new ContractedServiceContractLinkWriter(),
    private readonly services: PatientContractedServiceRepository = new PatientContractedServiceRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  private fail(err: unknown, res: Response, source: string, ids: Record<string, unknown>): void {
    if (respondInsuranceError(err, res)) return;
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminContractedServiceContractLinkController:${source}`, ...ids });
    res.status(500).json({ success: false, error: 'Failed to write contract link' });
  }

  private async respond(req: Request, res: Response, serviceId: string, requestNow: Date, status: 200 | 201): Promise<void> {
    const service = await this.services.findById(serviceId, requestNow);
    if (!service) {
      res.status(404).json({ success: false, error: 'Contracted service not found', code: 'SERVICE_NOT_FOUND' });
      return;
    }
    res.status(status).json({ success: true, data: projectContractedServiceForActor(service, hourlyValueActorOf(req)) });
  }

  /** POST …/contract-link */
  async create(req: Request, res: Response): Promise<void> {
    const params = linkParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createContractLinkSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const requestNow = this.clock();
      await this.writer.create(params.data.id, params.data.sid, { ...body.data, validTo: body.data.validTo ?? null }, this.actorUid(req));
      await this.respond(req, res, params.data.sid, requestNow, 201);
    } catch (err: unknown) {
      this.fail(err, res, 'create', { patientId: params.data.id, serviceId: params.data.sid });
    }
  }

  /** POST …/contract-link/end */
  async end(req: Request, res: Response): Promise<void> {
    const params = linkParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = endContractLinkSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const requestNow = this.clock();
      await this.writer.end(params.data.id, params.data.sid, body.data, this.actorUid(req));
      await this.respond(req, res, params.data.sid, requestNow, 200);
    } catch (err: unknown) {
      this.fail(err, res, 'end', { patientId: params.data.id, serviceId: params.data.sid });
    }
  }

  /** POST …/contract-link/supersede */
  async supersede(req: Request, res: Response): Promise<void> {
    const params = linkParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = supersedeContractLinkSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const requestNow = this.clock();
      await this.writer.supersede(params.data.id, params.data.sid, { ...body.data, validTo: body.data.validTo ?? null }, this.actorUid(req));
      await this.respond(req, res, params.data.sid, requestNow, 200);
    } catch (err: unknown) {
      this.fail(err, res, 'supersede', { patientId: params.data.id, serviceId: params.data.sid });
    }
  }
}
