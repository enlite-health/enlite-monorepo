import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { adminPatientsListSchema } from '../validators/adminPatientsListSchema';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import { createPatientSchema } from '../validators/createPatientSchema';
import { PatientQueryRepository } from '../../infrastructure/PatientQueryRepository';
import { GetPatientByIdUseCase } from '../../application/GetPatientByIdUseCase';
import {
  CreatePatientUseCase,
  PatientContactValidationError,
  type CreatePatientInput,
} from '../../application/CreatePatientUseCase';
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
  private readonly createPatientUseCase: CreatePatientUseCase;
  private readonly db: Pool;
  private readonly geocoder: GeocodingService;

  constructor(geocoder?: GeocodingService, createPatientUseCase?: CreatePatientUseCase) {
    this.repo = new PatientQueryRepository();
    this.getPatientByIdUseCase = new GetPatientByIdUseCase(this.repo);
    this.createPatientUseCase = createPatientUseCase ?? new CreatePatientUseCase();
    this.db = DatabaseConnection.getInstance().getPool();
    this.geocoder = geocoder ?? new GeocodingService();
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
        needsAttention: row.needsAttention,
        attentionReasons: row.attentionReasons,
        addressesCount: row.addressesCount,
        caseNumber: row.caseNumber,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));

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

      res.status(200).json({ success: true, data: result.patient });
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

  /** GET /api/admin/patients/stats */
  async getPatientStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.repo.stats();
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
