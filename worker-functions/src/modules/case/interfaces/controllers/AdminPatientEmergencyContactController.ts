import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { inPatientTransaction } from '../../application/patientTransaction';
import { PatientEmergencyMarkRepository } from '../../infrastructure/PatientEmergencyMarkRepository';
import { putEmergencyContactSchema } from '../validators/patientContactRowSchemas';

const patientIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * AdminPatientEmergencyContactController — marca de emergência do paciente (spec 018, PR-2, US-8,
 * D-A, SUP-39; `contracts/support-network.md`). Aponta `patients.emergency_*` para uma linha já
 * existente de `patient_responsibles` OU `patient_external_contacts` — nunca cria titular.
 *
 * Trilha (D-A #7): `patient_emergency_contact.write` leva uid/patientId/kind/contactId/op — NUNCA
 * nome nem telefone (o uid não vai à tela; `reportError` idem, só ids).
 */
export class AdminPatientEmergencyContactController {
  constructor(
    private readonly repo: PatientEmergencyMarkRepository = new PatientEmergencyMarkRepository(),
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

  /** PUT /api/admin/patients/:id/emergency-contact */
  async mark(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = putEmergencyContactSchema.safeParse(req.body);
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
      const outcome = await inPatientTransaction((client) =>
        this.repo.mark(params.data.id, body.data.kind, body.data.id, client),
      );
      if (outcome.outcome === 'not_found') {
        res.status(404).json({ success: false, error: 'Contact not found for this patient (or inactive)' });
        return;
      }
      if (outcome.outcome === 'requires_phone') {
        res.status(422).json({ success: false, error: 'O contato de emergência precisa ter telefone', code: 'EMERGENCY_CONTACT_REQUIRES_PHONE' });
        return;
      }
      logger.info({ msg: 'patient_emergency_contact.write', uid: actorUid, patientId: params.data.id, kind: body.data.kind, contactId: body.data.id, op: 'mark' });
      res.status(200).json({ success: true, data: { emergencyContactRef: { kind: body.data.kind, id: body.data.id } } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientEmergencyContactController:mark', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to mark emergency contact' });
    }
  }

  /** DELETE /api/admin/patients/:id/emergency-contact */
  async unmark(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const actorUid = this.actorUid(req);
      const prev = await this.repo.getRef(params.data.id, this.db);
      await inPatientTransaction((client) => this.repo.unmark(params.data.id, client));
      logger.info({ msg: 'patient_emergency_contact.write', uid: actorUid, patientId: params.data.id, kind: prev?.kind ?? null, contactId: prev?.id ?? null, op: 'unmark' });
      res.status(200).json({ success: true, data: { emergencyContactRef: null } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientEmergencyContactController:unmark', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to unmark emergency contact' });
    }
  }
}
