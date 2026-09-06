import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { PatientContractedServiceRepository, type ContractedServiceDetail } from '../../infrastructure/PatientContractedServiceRepository';
import { ContractedServiceProviderRepository, ProviderAlreadyActiveError } from '../../infrastructure/ContractedServiceProviderRepository';
import { DeviceTypeUnknownError } from '../../infrastructure/PatientDeviceTypeRepository';
import { AddressNotOfPatientError } from '../../infrastructure/PatientContractedServiceRepository';
import {
  createContractedServiceSchema,
  updateContractedServiceSchema,
  associateProviderSchema,
  updateProviderSchema,
} from '../validators/contractedServiceSchemas';
import { actorRolesOf, projectContractedServiceForActor, isAdminActor, bodyWritesHourlyValue } from '../../application/contractedServiceHourlyValueAccess';

const patientParamsSchema = z.object({ id: z.string().uuid() });
const serviceParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid() });
const providerParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid(), pid: z.string().uuid() });

/**
 * AdminPatientContractedServicesController — CRUD do serviço contratado (spec 013, bloco C).
 *
 *   GET/POST   /api/admin/patients/:id/contracted-services
 *   PATCH      /api/admin/patients/:id/contracted-services/:sid          (sem DELETE — lex C-a.4)
 *   POST/PATCH /api/admin/patients/:id/contracted-services/:sid/providers[/:pid]
 *
 * `hourlyValue` é redigido para quem não é admin (lex C-c.4) no ÚNICO ponto:
 * `projectContractedServiceForActor`. `professionalProfile` NUNCA entra em log/erro (lex C-b1) —
 * os `reportError` abaixo carregam só ids e nomes de campo, nunca `req.body`.
 */
export class AdminPatientContractedServicesController {
  constructor(
    private readonly repo: PatientContractedServiceRepository = new PatientContractedServiceRepository(),
    private readonly providerRepo: ContractedServiceProviderRepository = new ContractedServiceProviderRepository(),
  ) {}

  private project(req: Request, service: ContractedServiceDetail) {
    return projectContractedServiceForActor(service, actorRolesOf(req));
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  /**
   * Recusa (403) quem manda `hourlyValue` sem poder LÊ-LO. Devolve `true` quando já respondeu.
   * A rota é `staffOnly`, mas o campo é restrito a `admin` na leitura — sem esta guarda um
   * `recruiter`, que recebe `hourlyValue: null` em toda leitura, gravava 0 por cima do valor.
   */
  private refuseHourlyValueWrite(req: Request, res: Response): boolean {
    if (!bodyWritesHourlyValue(req.body) || isAdminActor(actorRolesOf(req))) return false;
    // lex C-b1: só o NOME do campo, nunca o valor.
    res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'hourlyValue' } });
    return true;
  }

  /** GET /api/admin/patients/:id/contracted-services */
  async list(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const services = await this.repo.listForPatient(params.data.id);
      res.status(200).json({ success: true, data: { services: services.map((s) => this.project(req, s)) } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContractedServicesController:list', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to list contracted services' });
    }
  }

  /** POST /api/admin/patients/:id/contracted-services */
  async create(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createContractedServiceSchema.safeParse(req.body);
    if (!body.success) {
      // lex C-b1: nunca o VALOR do corpo — só os nomes de campo.
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    if (this.refuseHourlyValueWrite(req, res)) return;
    try {
      const created = await this.repo.create({ ...body.data, patientId: params.data.id, actorUid: this.actorUid(req) });
      res.status(201).json({ success: true, data: this.project(req, created) });
    } catch (err: unknown) {
      if (err instanceof DeviceTypeUnknownError) {
        res.status(422).json({ success: false, error: 'Unknown device type code(s)', code: err.code, details: { codes: err.codes } });
        return;
      }
      // Migration 330: o banco recusou `addressId` de outro paciente (FK composta) — 422, como o
      // catálogo de dispositivos; nunca 500.
      if (err instanceof AddressNotOfPatientError) {
        res.status(422).json({ success: false, error: 'addressId does not belong to this patient', code: err.code, details: { addressId: err.addressId } });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContractedServicesController:create', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to create contracted service' });
    }
  }

  /** PATCH /api/admin/patients/:id/contracted-services/:sid */
  async update(req: Request, res: Response): Promise<void> {
    const params = serviceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = updateContractedServiceSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    if (this.refuseHourlyValueWrite(req, res)) return;
    try {
      const existing = await this.repo.findById(params.data.sid);
      // Guarda de posse: um :sid válido de OUTRO paciente não pode ser editado por este :id.
      if (!existing || existing.patientId !== params.data.id) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      const updated = await this.repo.update(params.data.sid, { ...body.data, actorUid: this.actorUid(req) });
      if (!updated) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      res.status(200).json({ success: true, data: this.project(req, updated) });
    } catch (err: unknown) {
      if (err instanceof DeviceTypeUnknownError) {
        res.status(422).json({ success: false, error: 'Unknown device type code(s)', code: err.code, details: { codes: err.codes } });
        return;
      }
      // Migration 330: o banco recusou `addressId` de outro paciente (FK composta) — 422, como o
      // catálogo de dispositivos; nunca 500.
      if (err instanceof AddressNotOfPatientError) {
        res.status(422).json({ success: false, error: 'addressId does not belong to this patient', code: err.code, details: { addressId: err.addressId } });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContractedServicesController:update', patientId: params.data.id, serviceId: params.data.sid });
      res.status(500).json({ success: false, error: 'Failed to update contracted service' });
    }
  }

  /** POST /api/admin/patients/:id/contracted-services/:sid/providers */
  async associateProvider(req: Request, res: Response): Promise<void> {
    const params = serviceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = associateProviderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const service = await this.repo.findById(params.data.sid);
      if (!service || service.patientId !== params.data.id) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      const created = await this.providerRepo.associate({
        serviceId: params.data.sid,
        workerId: body.data.workerId,
        weeklyHours: body.data.weeklyHours,
        country: service.country as 'AR' | 'BR',
        actorUid: this.actorUid(req),
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      if (err instanceof ProviderAlreadyActiveError) {
        res.status(409).json({ success: false, error: 'Worker already actively allocated to this service', code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContractedServicesController:associateProvider', serviceId: params.data.sid });
      res.status(500).json({ success: false, error: 'Failed to associate provider' });
    }
  }

  /** PATCH /api/admin/patients/:id/contracted-services/:sid/providers/:pid */
  async updateProvider(req: Request, res: Response): Promise<void> {
    const params = providerParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = updateProviderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const service = await this.repo.findById(params.data.sid);
      if (!service || service.patientId !== params.data.id) {
        res.status(404).json({ success: false, error: 'Contracted service not found' });
        return;
      }
      const provider = service.providers.find((p) => p.id === params.data.pid);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Provider allocation not found' });
        return;
      }
      const updated = await this.providerRepo.update(params.data.pid, { ...body.data, actorUid: this.actorUid(req) });
      // `null` = a linha sumiu entre a leitura e a escrita. 200 com `data: null` mente para um
      // cliente que tipa o campo como não-nulo — o irmão `update` do serviço já devolve 404.
      if (!updated) {
        res.status(404).json({ success: false, error: 'Provider allocation not found' });
        return;
      }
      res.status(200).json({ success: true, data: updated });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContractedServicesController:updateProvider', providerId: params.data.pid });
      res.status(500).json({ success: false, error: 'Failed to update provider allocation' });
    }
  }
}
