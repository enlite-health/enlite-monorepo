import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { adminPatientsListSchema } from '../validators/adminPatientsListSchema';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import { PatientQueryRepository } from '../../infrastructure/PatientQueryRepository';
import { GetPatientByIdUseCase } from '../../application/GetPatientByIdUseCase';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

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
  private readonly db: Pool;

  constructor() {
    this.repo = new PatientQueryRepository();
    this.getPatientByIdUseCase = new GetPatientByIdUseCase(this.repo);
    this.db = DatabaseConnection.getInstance().getPool();
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
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));

      res.status(200).json({ success: true, data, total });
    } catch (error: any) {
      console.error('[AdminPatientsController] listPatients error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list patients',
        details: error.message,
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
    } catch (error: any) {
      console.error('[AdminPatientsController] getPatientById error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get patient details',
        details: error.message,
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
      const result = await this.db.query<{
        id: string; patient_id: string; address_formatted: string;
        address_raw: string | null; address_type: string;
      }>(
        `INSERT INTO patient_addresses
           (patient_id, address_formatted, address_raw, address_type, display_order, source)
         VALUES ($1, $2, $3, $4,
           COALESCE($5, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_addresses WHERE patient_id = $1)),
           'admin_manual')
         RETURNING id, patient_id, address_formatted, address_raw, address_type`,
        [patientId, address_formatted, address_raw ?? null, address_type, displayOrderValue],
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error: any) {
      console.error('[AdminPatientsController] createPatientAddress error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create patient address',
        details: error.message,
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
        `SELECT id, address_formatted, address_raw, address_type, display_order, source, complement, lat, lng
         FROM patient_addresses
         WHERE patient_id = $1
         ORDER BY display_order ASC, created_at ASC`,
        [patientId],
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (error: any) {
      console.error('[AdminPatientsController] listPatientAddresses error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list patient addresses',
        details: error.message,
      });
    }
  }

  /** GET /api/admin/patients/stats */
  async getPatientStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.repo.stats();
      res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
      console.error('[AdminPatientsController] getPatientStats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get patient stats',
        details: error.message,
      });
    }
  }
}
