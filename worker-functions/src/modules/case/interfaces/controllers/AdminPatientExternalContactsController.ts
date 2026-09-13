import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { inPatientTransaction } from '../../application/patientTransaction';
import { PatientExternalContactRepository } from '../../infrastructure/PatientExternalContactRepository';
import { EmergencyContactRequiresPhoneError } from '../../infrastructure/EmergencyContactRequiresPhoneError';
import {
  externalContactIdParamsSchema,
  createExternalContactSchema,
  updateExternalContactSchema,
} from '../validators/patientContactRowSchemas';

const patientIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * AdminPatientExternalContactsController — escrita POR LINHA dos contatos externos sem vínculo
 * familiar (spec 018, PR-2, US-12, `lex` #4; `contracts/support-network.md`). Mesmo molde de
 * `AdminPatientContactRowsController` (PR-1): id de linha de OUTRO paciente é 404, transação
 * própria (`inPatientTransaction`), nunca DELETE (troca = desativar + criar, REGRA-08).
 */
export class AdminPatientExternalContactsController {
  constructor(
    private readonly repo: PatientExternalContactRepository = new PatientExternalContactRepository(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /** lex C6 — `created_by`/`deactivated_by` é o uid REAL do ator; sem ator, erro (não sentinela). */
  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new Error('escrita exige ator identificado (lex C6)');
    return uid;
  }

  private async patientExists(id: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows.length > 0;
  }

  /** POST /api/admin/patients/:id/external-contacts */
  async create(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = createExternalContactSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const actorUid = this.actorUid(req);
      const created = await inPatientTransaction((client) =>
        this.repo.insertOne(params.data.id, body.data, actorUid, client),
      );
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientExternalContactsController:create', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to create external contact' });
    }
  }

  /** PATCH /api/admin/patients/:id/external-contacts/:xid */
  async update(req: Request, res: Response): Promise<void> {
    const params = externalContactIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = updateExternalContactSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const updated = await inPatientTransaction((client) =>
        this.repo.updateOne(params.data.id, params.data.xid, body.data, client),
      );
      if (!updated) {
        res.status(404).json({ success: false, error: 'External contact not found' });
        return;
      }
      res.status(200).json({ success: true, data: updated });
    } catch (err: unknown) {
      if (err instanceof EmergencyContactRequiresPhoneError) {
        res.status(422).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientExternalContactsController:update', patientId: params.data.id, contactId: params.data.xid });
      res.status(500).json({ success: false, error: 'Failed to update external contact' });
    }
  }

  /** POST /api/admin/patients/:id/external-contacts/:xid/deactivate */
  async deactivate(req: Request, res: Response): Promise<void> {
    const params = externalContactIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const actorUid = this.actorUid(req);
      const outcome = await inPatientTransaction((client) =>
        this.repo.deactivate(params.data.id, params.data.xid, actorUid, client),
      );
      if (outcome.outcome === 'not_found') {
        res.status(404).json({ success: false, error: 'External contact not found' });
        return;
      }
      if (outcome.outcome === 'already_inactive') {
        res.status(409).json({ success: false, error: 'External contact already inactive' });
        return;
      }
      res.status(200).json({ success: true, data: { id: outcome.id, active: false, emergencyMarkCleared: outcome.emergencyMarkCleared ?? false } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientExternalContactsController:deactivate', patientId: params.data.id, contactId: params.data.xid });
      res.status(500).json({ success: false, error: 'Failed to deactivate external contact' });
    }
  }
}
