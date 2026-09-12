import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { inPatientTransaction } from '../../application/patientTransaction';
import { clinicalCellsOf } from '../../application/patientClinicalAccess';
import { canReadPatientContainer, patientContainerCell } from '../../application/patientContainerAccess';
import {
  PatientResponsibleRepository,
  ResponsiblePrimaryAlreadySetError,
} from '../../infrastructure/PatientResponsibleRepository';
import {
  PatientCoverageEmergencyContactRepository,
  CoverageEmergencyContactLimitReachedError,
} from '../../infrastructure/PatientCoverageEmergencyContactRepository';
import {
  responsibleIdParamsSchema,
  createResponsibleSchema,
  updateResponsibleSchema,
  coverageContactIdParamsSchema,
  createCoverageEmergencyContactSchema,
  updateCoverageEmergencyContactSchema,
} from '../validators/patientContactRowSchemas';

const patientIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * AdminPatientContactRowsController — escrita POR LINHA dos responsáveis e dos contatos de
 * emergência da cobertura (spec 018, PR-1, ADR-1; `contracts/support-network.md`).
 *
 * Substitui, para estes dois conjuntos, o caminho "manda a lista inteira" (`PATCH
 * /patients/:id/support-network` → 410; `emergencyContacts` fora do `PATCH /coverage`). Cada
 * escrita roda em transação própria (`inPatientTransaction` — RLS de país da stage, FR-005) e o
 * id de uma linha de OUTRO paciente nunca é encontrado (`WHERE id = $1 AND patient_id = $2` no
 * repositório) — 404, indistinguível de inexistente (mesma régua das rotas de serviço contratado).
 */
export class AdminPatientContactRowsController {
  constructor(
    private readonly responsibleRepo: PatientResponsibleRepository = new PatientResponsibleRepository(),
    private readonly coverageContactRepo: PatientCoverageEmergencyContactRepository = new PatientCoverageEmergencyContactRepository(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /**
   * lex C6 — `created_by`/`deactivated_by` é o uid REAL do ator; sem ator não há sentinela, há
   * erro (achado do gate `revisao-pr`: o `PatientSectionWriter` que este PR substitui lançava
   * `throw new Error('… escrita exige ator identificado (lex C6)')` para o mesmo caso — um
   * `?? 'unknown'` aqui revogava essa regra em silêncio). A rota é `staffOnly`; isto é a defesa
   * para o contexto de auth vir vazio mesmo assim.
   */
  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new Error('escrita exige ator identificado (lex C6)');
    return uid;
  }

  private async patientExists(id: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows.length > 0;
  }

  // ── Responsáveis ──────────────────────────────────────────────────────────────────────────

  /** POST /api/admin/patients/:id/responsibles */
  async createResponsible(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = createResponsibleSchema.safeParse(req.body);
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
        this.responsibleRepo.insertOne(params.data.id, { ...body.data, source: 'admin_manual' }, actorUid, client),
      );
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      if (err instanceof ResponsiblePrimaryAlreadySetError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:createResponsible', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to create responsible' });
    }
  }

  /** PATCH /api/admin/patients/:id/responsibles/:rid */
  async updateResponsible(req: Request, res: Response): Promise<void> {
    const params = responsibleIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = updateResponsibleSchema.safeParse(req.body);
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
        this.responsibleRepo.updateOne(params.data.id, params.data.rid, body.data, client),
      );
      if (!updated) {
        res.status(404).json({ success: false, error: 'Responsible not found' });
        return;
      }
      res.status(200).json({ success: true, data: updated });
    } catch (err: unknown) {
      if (err instanceof ResponsiblePrimaryAlreadySetError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:updateResponsible', patientId: params.data.id, responsibleId: params.data.rid });
      res.status(500).json({ success: false, error: 'Failed to update responsible' });
    }
  }

  /** POST /api/admin/patients/:id/responsibles/:rid/deactivate */
  async deactivateResponsible(req: Request, res: Response): Promise<void> {
    const params = responsibleIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const actorUid = this.actorUid(req);
      const outcome = await inPatientTransaction((client) =>
        this.responsibleRepo.deactivate(params.data.id, params.data.rid, actorUid, client),
      );
      if (outcome.outcome === 'not_found') {
        res.status(404).json({ success: false, error: 'Responsible not found' });
        return;
      }
      if (outcome.outcome === 'already_inactive') {
        res.status(409).json({ success: false, error: 'Responsible already inactive' });
        return;
      }
      res.status(200).json({ success: true, data: { id: outcome.id, active: false } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:deactivateResponsible', patientId: params.data.id, responsibleId: params.data.rid });
      res.status(500).json({ success: false, error: 'Failed to deactivate responsible' });
    }
  }

  // ── Contatos de emergência da cobertura ──────────────────────────────────────────────────────

  /** Sem `patient_care_team:read` o ator nunca viu o profissional direto — não pode escrever um (lex C3). */
  private refuseDirectProfessionalWithoutCareTeam(req: Request, res: Response, kind: string | undefined): boolean {
    if (kind !== 'DIRECT_PROFESSIONAL') return false;
    if (canReadPatientContainer(clinicalCellsOf(req), 'careTeam')) return false;
    res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'kind', cell: patientContainerCell('careTeam', 'read') } });
    return true;
  }

  /** POST /api/admin/patients/:id/coverage-emergency-contacts */
  async createCoverageEmergencyContact(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = createCoverageEmergencyContactSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    if (this.refuseDirectProfessionalWithoutCareTeam(req, res, body.data.kind)) return;
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const actorUid = this.actorUid(req);
      const created = await inPatientTransaction((client) =>
        this.coverageContactRepo.insertOne(params.data.id, body.data, actorUid, client),
      );
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      if (err instanceof CoverageEmergencyContactLimitReachedError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:createCoverageEmergencyContact', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to create coverage emergency contact' });
    }
  }

  /** PATCH /api/admin/patients/:id/coverage-emergency-contacts/:cid */
  async updateCoverageEmergencyContact(req: Request, res: Response): Promise<void> {
    const params = coverageContactIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = updateCoverageEmergencyContactSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      // O kind EFETIVO depois do PATCH: o que o corpo traz, senão o que a linha JÁ TEM (lex C3 —
      // sem `patient_care_team:read` o ator não pode nem editar uma linha que já é
      // DIRECT_PROFESSIONAL, mesmo sem tocar no `kind`).
      const kindAtual = body.data.kind ?? (await this.coverageContactRepo.getKind(params.data.id, params.data.cid)) ?? undefined;
      if (this.refuseDirectProfessionalWithoutCareTeam(req, res, kindAtual)) return;
      const updated = await inPatientTransaction((client) =>
        this.coverageContactRepo.updateOne(params.data.id, params.data.cid, body.data, client),
      );
      if (!updated) {
        res.status(404).json({ success: false, error: 'Coverage emergency contact not found' });
        return;
      }
      res.status(200).json({ success: true, data: updated });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:updateCoverageEmergencyContact', patientId: params.data.id, contactId: params.data.cid });
      res.status(500).json({ success: false, error: 'Failed to update coverage emergency contact' });
    }
  }

  /** POST /api/admin/patients/:id/coverage-emergency-contacts/:cid/deactivate */
  async deactivateCoverageEmergencyContact(req: Request, res: Response): Promise<void> {
    const params = coverageContactIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      if (!(await this.patientExists(params.data.id))) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      // lex C3: desativar uma linha DIRECT_PROFESSIONAL também exige `patient_care_team:read` —
      // sem a célula, o ator nunca a viu e não decide se ela desaparece.
      const kindAtual = (await this.coverageContactRepo.getKind(params.data.id, params.data.cid)) ?? undefined;
      if (this.refuseDirectProfessionalWithoutCareTeam(req, res, kindAtual)) return;
      const actorUid = this.actorUid(req);
      const outcome = await inPatientTransaction((client) =>
        this.coverageContactRepo.deactivate(params.data.id, params.data.cid, actorUid, client),
      );
      if (outcome.outcome === 'not_found') {
        res.status(404).json({ success: false, error: 'Coverage emergency contact not found' });
        return;
      }
      if (outcome.outcome === 'already_inactive') {
        res.status(409).json({ success: false, error: 'Coverage emergency contact already inactive' });
        return;
      }
      res.status(200).json({ success: true, data: { id: outcome.id, active: false } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientContactRowsController:deactivateCoverageEmergencyContact', patientId: params.data.id, contactId: params.data.cid });
      res.status(500).json({ success: false, error: 'Failed to deactivate coverage emergency contact' });
    }
  }
}
