import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';

/**
 * PatientAddressRepository
 *
 * Handles patient_addresses persistence used by the ClickUp sync pipeline.
 * Extracted from JobPostingARRepository to respect the 400-line limit.
 *
 * Geocoding is best-effort on insert: failures (missing key, quota, etc.)
 * persist with lat/lng=NULL so the backfill job can recover later.
 */
export class PatientAddressRepository {
  private pool: Pool;
  private geocoder: GeocodingService;
  constructor(geocoder?: GeocodingService) {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.geocoder = geocoder ?? new GeocodingService();
  }

  /**
   * Resolves or creates a patient_addresses row for a given patient + address text.
   *
   * Logic:
   * 1. If both addressFormatted and addressRaw are null → return null.
   * 2. Try exact match on address_formatted (case-insensitive trim).
   * 3. If not found and addressFormatted is not null → INSERT new row and return new id.
   * 4. Return matched/created id.
   */
  async resolveOrCreatePatientAddress(params: {
    patientId: string;
    addressFormatted: string | null;
    addressRaw: string | null;
  }): Promise<string | null> {
    const { patientId, addressFormatted, addressRaw } = params;

    if (!addressFormatted && !addressRaw) return null;

    if (addressFormatted) {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id
         FROM patient_addresses
         WHERE patient_id = $1
           AND archived_at IS NULL
           AND TRIM(LOWER(address_formatted)) = TRIM(LOWER($2))
         LIMIT 1`,
        [patientId, addressFormatted],
      );

      if (existing.rows.length > 0) {
        return existing.rows[0].id;
      }

      // Not found → geocode (best-effort) + create new patient_addresses row
      const { lat, lng } = await this.tryGeocode(addressFormatted);

      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO patient_addresses
           (patient_id, address_type, address_formatted, address_raw, display_order, source, lat, lng)
         VALUES ($1, 'service', $2, $3,
           (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL),
           'clickup_sync', $4, $5)
         RETURNING id`,
        [patientId, addressFormatted, addressRaw ?? null, lat, lng],
      );

      return inserted.rows[0].id;
    }

    // addressRaw only (no formatted address) — try matching on address_raw
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM patient_addresses
       WHERE patient_id = $1
         AND archived_at IS NULL
         AND TRIM(LOWER(address_raw)) = TRIM(LOWER($2))
       LIMIT 1`,
      [patientId, addressRaw],
    );

    return existing.rows[0]?.id ?? null;
  }

  /**
   * Best-effort geocode wrapper. Never throws — quota / key missing /
   * network errors result in lat/lng=null and the caller persists without
   * coords. The backfill job recovers unresolved rows later.
   */
  private async tryGeocode(query: string): Promise<{ lat: number | null; lng: number | null }> {
    try {
      const res = await this.geocoder.geocode(query);
      return res ? { lat: res.latitude, lng: res.longitude } : { lat: null, lng: null };
    } catch {
      return { lat: null, lng: null };
    }
  }
}
