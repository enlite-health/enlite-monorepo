/**
 * AdminPatientDiagnosesController — CRUD do diagnóstico estruturado (spec 016 F2, D263).
 *
 *   GET   /api/admin/patients/:id/diagnoses
 *   POST  /api/admin/patients/:id/diagnoses
 *   PATCH /api/admin/patients/:id/diagnoses/:did          (sem DELETE — sem rota física)
 *
 * 🔴 Decisão de desenho explícita (não achado, registrada no relatório da fase): o repositório
 * default deste controller nasce escopado a `DiagnosisSource.PANEL` — o escritor do painel é
 * FISICAMENTE incapaz de tocar uma linha `CLICKUP`/`BACKFILL` (D263, "escopo por construtor").
 * Isso inclui o PATCH: promover/desativar um diagnóstico de OUTRA origem por esta rota devolve
 * 404 (o repositório nem acha a linha), o MESMO código de "não existe" — nunca um 403 à parte,
 * para não vazar pela resposta HTTP se uma origem existe ou não. O F4 (webhook do ClickUp) usa
 * seu PRÓPRIO controller/serviço, escopado a `DiagnosisSource.CLICKUP`.
 *
 * `conceptUri` é OPACO — o servidor resolve (Contrato de arquitetura); o cliente NUNCA manda
 * code/title/chapter/release. A resposta é sempre `DiagnosisPublicView` (REQ-21: sem código).
 */
import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { PatientDiagnosisService } from '../../application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../../infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { createTerminologyPort } from '../../../terminology/infrastructure/TerminologyPortFactory';
import { TerminologyUnavailableError } from '../../../terminology/domain/UnavailableTerminology';
import { toDiagnosisPublicView } from '../DiagnosisPublicView';
import {
  patientParamsSchema,
  diagnosisParamsSchema,
  createDiagnosisSchema,
  patchDiagnosisSchema,
} from '../validators/diagnosisSchemas';

function defaultService(): PatientDiagnosisService {
  return new PatientDiagnosisService(
    createTerminologyPort(process.env),
    new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL),
  );
}

export class AdminPatientDiagnosesController {
  constructor(private readonly service: PatientDiagnosisService = defaultService()) {}

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  /** GET /api/admin/patients/:id/diagnoses */
  async list(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const result = await this.service.listForPatient(params.data.id);
      if (!result.found) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json({ success: true, data: { diagnoses: result.diagnoses.map(toDiagnosisPublicView) } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientDiagnosesController:list', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to list diagnoses' });
    }
  }

  /** POST /api/admin/patients/:id/diagnoses */
  async create(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createDiagnosisSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const result = await this.service.recordDiagnosis({
        patientId: params.data.id,
        conceptUri: body.data.conceptUri,
        isPrimary: body.data.isPrimary,
        actorUid: this.actorUid(req),
      });
      switch (result.outcome) {
        case 'patient_not_found':
          res.status(404).json({ success: false, error: 'Patient not found' });
          return;
        case 'concept_not_resolved':
          res.status(422).json({ success: false, error: 'conceptUri does not resolve in the terminology catalog', code: 'CONCEPT_NOT_RESOLVED' });
          return;
        // C3 (QA-caça) — resolve, mas é capítulo ou extensão: nunca um fato clínico isolado.
        // Mensagem NÃO ecoa o concept_code (o servidor nunca manda o código para o cliente).
        case 'not_diagnosable':
          res.status(422).json({ success: false, error: 'conceptUri does not identify a diagnosable concept (chapter or extension are not diagnoses)', code: 'CONCEPT_NOT_DIAGNOSABLE' });
          return;
        // C1 (QA-caça) — 23505 do índice de principal mapeado para 409, nunca 500.
        case 'primary_race':
          res.status(409).json({ success: false, error: 'Primary diagnosis change collided with a concurrent write', code: 'PRIMARY_DIAGNOSIS_RACE' });
          return;
        case 'already_active':
          res.status(409).json({ success: false, error: 'Concept already active for this patient in this source', code: 'DIAGNOSIS_ALREADY_ACTIVE' });
          return;
        case 'created':
          res.status(201).json({ success: true, data: toDiagnosisPublicView(result.diagnosis) });
          return;
      }
    } catch (err: unknown) {
      if (err instanceof TerminologyUnavailableError) {
        res.status(503).json({ success: false, error: err.message, code: 'TERMINOLOGY_UNAVAILABLE' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientDiagnosesController:create', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to record diagnosis' });
    }
  }

  /** PATCH /api/admin/patients/:id/diagnoses/:did */
  async update(req: Request, res: Response): Promise<void> {
    const params = diagnosisParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = patchDiagnosisSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const actorUid = this.actorUid(req);
      const result = body.data.isPrimary
        ? await this.service.setPrimary(params.data.id, params.data.did, actorUid)
        : await this.service.deactivate(params.data.id, params.data.did, actorUid);

      switch (result.outcome) {
        case 'not_found':
          res.status(404).json({ success: false, error: 'Diagnosis not found' });
          return;
        case 'conflict':
          // C1 (QA-caça) — 'primary_race' é o 23505 do índice de principal mapeado (nunca 500);
          // 'inactive'/'already_inactive' são os conflitos pré-existentes (promover/baixar um
          // diagnóstico já inativo). Todos 409 — o código diferencia a causa.
          res.status(409).json(
            result.reason === 'primary_race'
              ? { success: false, error: 'Primary diagnosis change collided with a concurrent write', code: 'PRIMARY_DIAGNOSIS_RACE' }
              : { success: false, error: 'Diagnosis is not active', code: 'DIAGNOSIS_NOT_ACTIVE' },
          );
          return;
        case 'ok':
          res.status(200).json({ success: true, data: toDiagnosisPublicView(result.diagnosis) });
          return;
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientDiagnosesController:update', patientId: params.data.id, diagnosisId: params.data.did });
      res.status(500).json({ success: false, error: 'Failed to update diagnosis' });
    }
  }
}
