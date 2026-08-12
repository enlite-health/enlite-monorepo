import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GeocodingService } from '../../../../infrastructure/services/GeocodingService';
import { loggingAls, reportError } from '@shared/logging';
import { JobPostingAuditRepository } from '../../infrastructure/JobPostingAuditRepository';

/**
 * VacancyAddressReviewController
 *
 * Handles the POST /api/admin/vacancies/:id/resolve-address-review endpoint.
 * Resolves the patient_address_id linkage for vacancies that failed automatic matching.
 *
 * Kept in a separate file to stay under the 400-line limit of VacancyCrudController.
 */

const resolveAddressBodySchema = z.union([
  z.object({
    patient_address_id: z.string().uuid(),
    createAddress: z.undefined(),
  }),
  z.object({
    patient_address_id: z.undefined(),
    createAddress: z.object({
      address_formatted: z.string().min(1),
      address_raw: z.string().optional(),
      address_type: z.string().min(1),
    }),
  }),
]);

export class VacancyAddressReviewController {
  private readonly db: Pool;
  private readonly geocoder: GeocodingService;
  private readonly auditRepo: JobPostingAuditRepository;

  constructor(geocoder?: GeocodingService) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.geocoder = geocoder ?? new GeocodingService();
    this.auditRepo = new JobPostingAuditRepository();
  }

  /** POST /api/admin/vacancies/:id/resolve-address-review */
  async resolveAddressReview(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    const bodyResult = resolveAddressBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    try {
      // 1. Fetch the vacancy — verify it exists and is not deleted
      const vacancyResult = await this.db.query<{ id: string; patient_id: string | null }>(
        `SELECT id, patient_id FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (vacancyResult.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const vacancy = vacancyResult.rows[0];
      const patientId = vacancy.patient_id;

      let resolvedAddressId: string;

      if (bodyResult.data.createAddress) {
        // 3. Create a new address for the patient
        const { address_formatted, address_raw, address_type } = bodyResult.data.createAddress;

        if (!patientId) {
          res.status(422).json({
            success: false,
            error: 'Cannot create address: vacancy has no associated patient',
          });
          return;
        }

        // Best-effort geocode — failures persist with lat/lng=NULL.
        let lat: number | null = null;
        let lng: number | null = null;
        try {
          const geo = await this.geocoder.geocode(address_formatted);
          if (geo) {
            lat = geo.latitude;
            lng = geo.longitude;
          }
        } catch {
          // best-effort
        }

        const insertResult = await this.db.query<{ id: string }>(
          `INSERT INTO patient_addresses
             (patient_id, address_formatted, address_raw, address_type, source, lat, lng)
           VALUES ($1, $2, $3, $4, 'admin_review', $5, $6)
           RETURNING id`,
          [patientId, address_formatted, address_raw ?? null, address_type, lat, lng],
        );

        resolvedAddressId = insertResult.rows[0].id;
      } else {
        resolvedAddressId = bodyResult.data.patient_address_id as string;
      }

      // 4. Validate the address belongs to the vacancy's patient AND is active
      // (archived_at IS NULL). Archived addresses are kept around to preserve
      // historic vacancies — they must not be selectable for new bindings.
      if (patientId) {
        const ownerCheck = await this.db.query<{ exists: boolean }>(
          `SELECT 1 FROM patient_addresses
            WHERE id = $1
              AND patient_id = $2
              AND archived_at IS NULL`,
          [resolvedAddressId, patientId],
        );

        if (ownerCheck.rows.length === 0) {
          res.status(422).json({
            success: false,
            error: 'Address does not belong to the vacancy patient',
          });
          return;
        }
      }

      // 5. Update job_posting + audit UPDATED (patient_address_id) in one transaction
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (req as any).user as { uid?: string } | undefined;
      const actorUserId = user?.uid ?? null;
      const traceId = loggingAls.getStore()?.traceId ?? null;

      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      const updateClient = await this.db.connect();
      try {
        await updateClient.query('BEGIN');
        await updateClient.query(
          `UPDATE job_postings SET patient_address_id = $1, updated_at = NOW() WHERE id = $2`,
          [resolvedAddressId, id],
        );
        await this.auditRepo.logEventSafe(updateClient, {
          jobPostingId: id,
          eventType: 'UPDATED',
          fieldName: 'patient_address_id',
          changes: { before: null, after: resolvedAddressId },
          actorUserId,
          actorType: 'HUMAN',
          actorLabel: 'admin_panel',
          traceId,
        });
        await updateClient.query('COMMIT');
      } catch (err) {
        await updateClient.query('ROLLBACK');
        throw err;
      } finally {
        updateClient.release();
      }

      res.status(200).json({
        success: true,
        data: { id, patient_address_id: resolvedAddressId },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyAddressReviewController:resolveAddressReview' });
      res.status(500).json({
        success: false,
        error: 'Failed to resolve address review',
        details: msg,
      });
    }
  }
}
