import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { adminPatientsListSchema } from '../validators/adminPatientsListSchema';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import { createPatientSchema } from '../validators/createPatientSchema';
import { PatientQueryRepository } from '../../infrastructure/PatientQueryRepository';
import { GetPatientByIdUseCase } from '../../application/GetPatientByIdUseCase';
import { projectPatientClinicalForActor, clinicalCellsOf, canReadPatientClinical, PATIENT_CLINICAL_READ_CELL } from '../../application/patientClinicalAccess';
import { GetPatientFunnelUseCase } from '../../application/GetPatientFunnelUseCase';
import { patientFunnelQuerySchema } from '../../application/patientFunnelSchema';
import {
  CreatePatientUseCase,
  PatientContactValidationError,
  type CreatePatientInput,
} from '../../application/CreatePatientUseCase';
import {
  ActivatePatientUseCase,
  PatientNotFoundError,
  NoActiveAddressError,
} from '../../application/ActivatePatientUseCase';
import {
  PatientService,
  type PatientGeneralSectionData,
  type PatientRelatedInput,
} from '../../application/PatientService';
import type { PatientStatus } from '../../domain/enums/PatientStatus';
import {
  SECTION_SCHEMAS,
  patientSectionParamSchema,
  patientStatusSchema,
} from '../validators/patientSectionSchemas';
import {
  PatientTestFixtureService,
  NotATestPatientError,
  TestVacancyHasApplicationsError,
} from '../../application/PatientTestFixtureService';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GeocodingService } from '../../../../infrastructure/services/GeocodingService';
import { fetchPatientVacancies } from '../../infrastructure/PatientVacanciesQueryHelper';

const createPatientAddressSchema = z.object({
  address_formatted: z.string().min(1),
  address_raw: z.string().optional(),
  address_type: z.enum(['primary', 'secondary', 'service']).default('secondary'),
  display_order: z.number().int().positive().optional(),
});

const patientIdSchema = z.object({
  patientId: z.string().uuid({ message: 'patientId must be a valid UUID' }),
});

/**
 * AdminPatientsController
 *
 * Endpoints:
 *   GET /api/admin/patients       — list with filters + pagination
 *   GET /api/admin/patients/stats — aggregate counters
 *   GET /api/admin/patients/:id   — full patient detail (read-only)
 *
 * No business logic here — delegates to use cases / repositories.
 * Auth is enforced at route level (requireStaff).
 */
export class AdminPatientsController {
  private readonly repo: PatientQueryRepository;
  private readonly getPatientByIdUseCase: GetPatientByIdUseCase;
  private readonly getPatientFunnelUseCase: GetPatientFunnelUseCase;
  private readonly createPatientUseCase: CreatePatientUseCase;
  private readonly activatePatientUseCase: ActivatePatientUseCase;
  private readonly patientService: PatientService;
  private readonly testFixtures: PatientTestFixtureService;
  private readonly db: Pool;
  private readonly geocoder: GeocodingService;

  constructor(
    geocoder?: GeocodingService,
    createPatientUseCase?: CreatePatientUseCase,
    patientService?: PatientService,
    activatePatientUseCase?: ActivatePatientUseCase,
  ) {
    this.repo = new PatientQueryRepository();
    this.getPatientByIdUseCase = new GetPatientByIdUseCase(this.repo);
    this.db = DatabaseConnection.getInstance().getPool();
    this.getPatientFunnelUseCase = new GetPatientFunnelUseCase(this.db);
    this.createPatientUseCase = createPatientUseCase ?? new CreatePatientUseCase();
    this.patientService = patientService ?? new PatientService();
    this.activatePatientUseCase = activatePatientUseCase ?? new ActivatePatientUseCase();
    this.geocoder = geocoder ?? new GeocodingService();
    this.testFixtures = new PatientTestFixtureService(this.db);
  }

  /**
   * PATCH /api/admin/patients/:id/test-flag   body: { isTest: boolean }
   *
   * Marca um paciente como sintético (synthetic monitoring). Espelha
   * `PATCH /api/admin/workers/:id/test-flag`. admin-only na rota.
   */
  async updatePatientTestFlag(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse({ patientId: req.params.id });
    if (!paramsResult.success) {
      res.status(400).json({ success: false, error: 'Invalid patient id' });
      return;
    }
    const bodyResult = z.object({ isTest: z.boolean() }).safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    try {
      const isTest = await this.testFixtures.setTestFlag(
        paramsResult.data.patientId,
        bodyResult.data.isTest,
      );
      if (isTest === null) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json({ success: true, data: { isTest } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:updatePatientTestFlag' });
      res.status(500).json({ success: false, error: 'Failed to update test flag' });
    }
  }

  /**
   * DELETE /api/admin/patients/:id — purga um paciente SINTÉTICO.
   *
   * Só age sobre `is_test = true`; paciente real devolve **409**, nunca apaga.
   * Limpa junto o evento do Google Calendar, a entrevista e as vagas geradas —
   * é o teardown da jornada diária do synthetic monitoring.
   */
  async purgeTestPatient(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse({ patientId: req.params.id });
    if (!paramsResult.success) {
      res.status(400).json({ success: false, error: 'Invalid patient id' });
      return;
    }

    try {
      // C2 — o ator vai para o log da eliminação: sem a linha no banco, ele é a
      // única evidência de quem apagou.
      const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id ?? null;
      const result = await this.testFixtures.purge(paramsResult.data.patientId, actorUid);
      if (result === null) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof NotATestPatientError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      // C3 — a vaga sintética tem candidatura de prestador real: 409, não 500.
      // A limpeza não pode custar o dado de quem se candidatou de verdade.
      if (err instanceof TestVacancyHasApplicationsError) {
        res.status(409).json({
          success: false,
          error: err.message,
          code: err.code,
          applications: err.applications,
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:purgeTestPatient' });
      res.status(500).json({ success: false, error: 'Failed to purge test patient' });
    }
  }

  /**
   * PATCH /api/admin/patients/:id/:section
   *   section ∈ general | clinical | support-network | service
   *
   * Section-scoped partial update. The section decides the whitelist (a
   * per-section zod schema); an unknown section or an unknown field is a 400.
   * 404 when the patient does not exist. Delegates the write to
   * PatientService.updatePatientSection.
   */
  async updatePatientSection(req: Request, res: Response): Promise<void> {
    const paramsResult = patientSectionParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const { id, section } = paramsResult.data;
    const bodyResult = SECTION_SCHEMAS[section].safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    // Ponto ÚNICO (D211.2, lex C1): quem não pode LER o texto clínico restrito também não o escreve.
    if ('emergencyInstructions' in (bodyResult.data as Record<string, unknown>) && !canReadPatientClinical(clinicalCellsOf(req))) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'emergencyInstructions', cell: PATIENT_CLINICAL_READ_CELL } });
      return;
    }

    try {
      const exists = await this.db.query('SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (exists.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }

      // Autoria (REQ-01): o uid do staff vai para a mesma transação do PATCH.
      const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
      await this.patientService.updatePatientSection(
        id,
        section,
        bodyResult.data as PatientGeneralSectionData | PatientRelatedInput,
        actorUid ? { uid: actorUid } : undefined,
      );
      res.status(200).json({ success: true, data: { id } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:updatePatientSection', section });
      res.status(500).json({
        success: false,
        error: 'Failed to update patient section',
        details: e.message,
      });
    }
  }

  /**
   * PUT /api/admin/patients/:id/status — used by the kanban to move a card.
   * Body: { status }. A value outside PatientStatus is a 400 (validated here,
   * before hitting the service). 404 when the patient does not exist.
   */
  async updatePatientStatus(req: Request, res: Response): Promise<void> {
    const paramsResult = adminPatientParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const bodyResult = patientStatusSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid status',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    const { id } = paramsResult.data;
    const { status } = bodyResult.data;

    try {
      const result = await this.patientService.moveStatus(id, status as PatientStatus);
      res.status(200).json({ success: true, data: { id: result.id, status: result.status } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (/not found/i.test(e.message)) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      reportError(e, { source: 'AdminPatientsController:updatePatientStatus' });
      res.status(500).json({
        success: false,
        error: 'Failed to update patient status',
        details: e.message,
      });
    }
  }

  /**
   * POST /api/admin/patients/:id/activate
   *
   * Approves the patient and opens recruitment: creates ONE draft vacancy per
   * active location (decisão D5) and moves the patient to ACTIVE. Idempotent —
   * an already-ACTIVE patient returns 200 with createdVacancyIds:[] (no dup).
   *   - 404 when the patient does not exist.
   *   - 422 when the patient has no active address (cannot activate without a
   *     location — nothing to create).
   */
  async activatePatient(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await this.activatePatientUseCase.execute(parsed.data.id);
      res.status(200).json({
        success: true,
        data: {
          patientId: result.patientId,
          status: result.status,
          createdVacancyIds: result.createdVacancyIds,
        },
      });
    } catch (err: unknown) {
      if (err instanceof PatientNotFoundError) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      if (err instanceof NoActiveAddressError) {
        res.status(422).json({ success: false, error: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:activatePatient' });
      res.status(500).json({
        success: false,
        error: 'Failed to activate patient',
        details: e.message,
      });
    }
  }

  /**
   * POST /api/admin/patients — manual creation of a native patient by the
   * admission team (Fase 1 Task 2). Born origin='admin_manual', status
   * ADMISSION. The contact-channel invariant is enforced by the use-case and
   * surfaced here as a 400 (client problem), never a 500.
   */
  async createPatient(req: Request, res: Response): Promise<void> {
    const parsed = createPatientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { id } = await this.createPatientUseCase.execute(parsed.data as CreatePatientInput);
      res.status(201).json({ success: true, data: { id } });
    } catch (err: unknown) {
      if (err instanceof PatientContactValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:createPatient' });
      res.status(500).json({
        success: false,
        error: 'Failed to create patient',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients */
  async listPatients(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientsListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { rows, total } = await this.repo.list(parsed.data);

      const data = rows.map((row) => ({
        id: row.id,
        clickupTaskId: row.clickupTaskId,
        firstName: row.firstName,
        lastName: row.lastName,
        diagnosis: row.diagnosis,
        dependencyLevel: row.dependencyLevel,
        clinicalSpecialty: row.clinicalSpecialty,
        serviceType: row.serviceType ?? [],
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        sex: row.sex,
        status: row.status,
        needsAttention: row.needsAttention,
        isTest: row.isTest,
        attentionReasons: row.attentionReasons,
        addressesCount: row.addressesCount,
        caseNumber: row.caseNumber,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // SLA de inatividade (Fase 4) — o kanban lê isto. Aditivo.
        stageEnteredAt: row.stageEnteredAt ?? null,
        hoursInStage: row.hoursInStage ?? null,
        slaThresholdHours: row.slaThresholdHours ?? null,
        slaBreached: row.slaBreached ?? false,
        // Desempate do lead sem nome — JÁ mascarado pelo repositório (lex C1).
        // Ausente (null) em toda ficha com nome real (lex C2).
        leadContactEmailMasked: row.leadContactEmailMasked ?? null,
        leadContactIsResponsible: row.leadContactIsResponsible ?? false,
      }));

      // Trilha de LEITURA de contato (lex 30/08 C5, molde OP-08/OP-11-D225):
      // quem leu, de que país, quantos e QUAIS pacientes. Nunca o e-mail — nem
      // mascarado. Sem contato exposto não há linha (minimização).
      const contactRows = data.filter((d) => d.leadContactEmailMasked != null);
      if (contactRows.length > 0) {
        logger.info({
          msg: 'patient_lead_contact.read',
          uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null,
          country: parsed.data.country ?? null,
          n: contactRows.length,
          patientIds: contactRows.map((d) => d.id),
        });
      }

      res.status(200).json({ success: true, data, total });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatients' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patients',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients/:id — full patient detail */
  async getPatientById(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await this.getPatientByIdUseCase.execute(parsed.data.id);

      if (!result.found) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }

      // Ponto ÚNICO de leitura do texto clínico restrito (D211.2): redige para quem não pode.
      const cells = clinicalCellsOf(req);
      const projected = projectPatientClinicalForActor(result.patient as unknown as Record<string, unknown>, cells);
      // Trilha de LEITURA sem valor (lex 29/08 C3, molde OP-08): uid, paciente, país, decisão, quando.
      // Nunca o texto, nunca o nome. Request redigida não gera linha (minimização).
      if (canReadPatientClinical(cells)) {
        logger.info({ msg: 'patient_clinical.read', uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null, patientId: parsed.data.id, country: (result.patient as { country?: string | null }).country ?? null, decision: 'allowed' });
      }
      res.status(200).json({ success: true, data: projected });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientById' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient details',
        details: e.message,
      });
    }
  }

  /** POST /api/admin/patients/:patientId/addresses */
  async createPatientAddress(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const bodyResult = createPatientAddressSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    const { patientId } = paramsResult.data;
    const { address_formatted, address_raw, address_type, display_order } = bodyResult.data;

    try {
      const displayOrderValue = display_order ?? null;

      // Best-effort geocode — failures persist with lat/lng=NULL and the
      // backfill job recovers later.
      let lat: number | null = null;
      let lng: number | null = null;
      try {
        const res = await this.geocoder.geocode(address_formatted);
        if (res) {
          lat = res.latitude;
          lng = res.longitude;
        }
      } catch {
        // best-effort
      }

      const result = await this.db.query<{
        id: string; patient_id: string; address_formatted: string;
        address_raw: string | null; address_type: string;
      }>(
        `INSERT INTO patient_addresses
           (patient_id, address_formatted, address_raw, address_type, display_order, source, lat, lng)
         VALUES ($1, $2, $3, $4,
           COALESCE($5, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL)),
           'admin_manual', $6, $7)
         RETURNING id, patient_id, address_formatted, address_raw, address_type`,
        [patientId, address_formatted, address_raw ?? null, address_type, displayOrderValue, lat, lng],
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:createPatientAddress' });
      res.status(500).json({
        success: false,
        error: 'Failed to create patient address',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients/:patientId/addresses */
  async listPatientAddresses(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const { patientId } = paramsResult.data;

    try {
      const result = await this.db.query<{
        id: string;
        address_formatted: string;
        address_raw: string | null;
        address_type: string;
        display_order: number | null;
        source: string | null;
        complement: string | null;
        lat: string | null;
        lng: string | null;
      }>(
        // archived_at IS NULL: o form de criação de vaga e o detalhe do
        // paciente só veem endereços ativos. Endereços arquivados continuam
        // existindo na tabela pra preservar o histórico das vagas antigas
        // que apontam pra eles (ver migration 198 e docs/features/
        // vacancy-creation/06-endereco-servico.md).
        `SELECT id, address_formatted, address_raw, address_type, display_order, source, complement, lat, lng
         FROM patient_addresses
         WHERE patient_id = $1
           AND archived_at IS NULL
         ORDER BY display_order ASC, created_at ASC`,
        [patientId],
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatientAddresses' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patient addresses',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients/stats?country=AR|BR */
  async getPatientStats(req: Request, res: Response): Promise<void> {
    try {
      const country = req.query.country === 'AR' || req.query.country === 'BR'
        ? req.query.country
        : undefined;
      const stats = await this.repo.stats(country);
      res.status(200).json({ success: true, data: stats });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientStats' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient stats',
        details: e.message,
      });
    }
  }

  /**
   * GET /api/admin/patients/funnel?country=AR|BR&from=ISO&to=ISO
   *
   * Conversão do funil de pacientes por país e período (Fase 4). Sem from/to,
   * usa os últimos 30 dias. Controller fino — delega ao GetPatientFunnelUseCase.
   */
  async getPatientFunnel(req: Request, res: Response): Promise<void> {
    const parsed = patientFunnelQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const data = await this.getPatientFunnelUseCase.execute(parsed.data);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientFunnel' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient funnel',
        details: e.message,
      });
    }
  }

  /**
   * GET /api/admin/patients/:id/vacancies
   *
   * Lists all non-deleted job_postings for a patient, ordered newest first.
   * Returns all vagas regardless of is_draft or status so the operator has
   * the complete history in one call.
   */
  async listPatientVacancies(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const vacancies = await fetchPatientVacancies(this.db, parsed.data.id);
      res.status(200).json({ success: true, data: vacancies });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatientVacancies' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patient vacancies',
        details: e.message,
      });
    }
  }
}
