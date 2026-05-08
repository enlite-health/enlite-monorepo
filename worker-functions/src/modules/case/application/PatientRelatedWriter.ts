/**
 * PatientRelatedWriter
 *
 * Pure DB helpers for replacing the auxiliary collections attached to a patient:
 * addresses (with best-effort geocoding) and professionals (with KMS encryption).
 *
 * Extracted from PatientService to keep that file within the 400-line limit.
 * No business logic — only persistence.
 */

import { geocodePatientAddressesBestEffort } from '../infrastructure/geocodePatientAddresses';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import { PatientAddress, PatientProfessional } from '../../../infrastructure/repositories/PatientRepository';

export async function replacePatientAddresses(
  patientId: string,
  addresses: PatientAddress[],
  client: import('pg').PoolClient,
  geocoder: GeocodingService,
): Promise<void> {
  // Merge by (patient_id, display_order) instead of DELETE+INSERT so that
  // existing IDs survive the upsert. job_postings.patient_address_id has
  // ON DELETE RESTRICT, so dropping a referenced address aborts the whole
  // sync transaction.
  const valid = addresses.filter(a => a.addressFormatted || a.addressRaw);

  const { rows: existing } = await client.query<{ id: string; display_order: number }>(
    'SELECT id, display_order FROM patient_addresses WHERE patient_id = $1',
    [patientId],
  );
  const existingByOrder = new Map<number, string>(
    existing.map(r => [r.display_order, r.id]),
  );

  if (valid.length === 0) return;

  // Best-effort geocoding — never blocks the upsert. Failures persist
  // lat/lng=NULL so the backfill job can recover them later.
  const geocoded = await geocodePatientAddressesBestEffort(valid, geocoder, {
    delayMs: 0,
    timeoutMs: 8000,
  });

  for (const g of geocoded) {
    const a = g.address;
    const existingId = existingByOrder.get(a.displayOrder);

    if (existingId) {
      await client.query(
        `UPDATE patient_addresses SET
           address_type      = $2,
           address_formatted = $3,
           address_raw       = $4,
           state             = $5,
           city              = $6,
           neighborhood      = $7,
           lat               = $8,
           lng               = $9
         WHERE id = $1`,
        [
          existingId,
          a.addressType,
          a.addressFormatted ?? null,
          a.addressRaw ?? null,
          a.state ?? null,
          a.city ?? null,
          a.neighborhood ?? null,
          g.lat,
          g.lng,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO patient_addresses
           (patient_id, address_type, address_formatted, address_raw, display_order, state, city, neighborhood, lat, lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          patientId,
          a.addressType,
          a.addressFormatted ?? null,
          a.addressRaw ?? null,
          a.displayOrder,
          a.state ?? null,
          a.city ?? null,
          a.neighborhood ?? null,
          g.lat,
          g.lng,
        ],
      );
    }
  }

  const newOrders = new Set(geocoded.map(g => g.address.displayOrder));
  const obsoleteIds = existing
    .filter(r => !newOrders.has(r.display_order))
    .map(r => r.id);

  if (obsoleteIds.length > 0) {
    await client.query(
      `DELETE FROM patient_addresses
       WHERE id = ANY($1::uuid[])
         AND NOT EXISTS (
           SELECT 1 FROM job_postings jp
           WHERE jp.patient_address_id = patient_addresses.id
         )`,
      [obsoleteIds],
    );
  }
}

export async function replacePatientProfessionals(
  patientId: string,
  professionals: PatientProfessional[],
  client: import('pg').PoolClient,
): Promise<void> {
  const { KMSEncryptionService } = await import('@shared/security/KMSEncryptionService');
  const encryptionService = new KMSEncryptionService();

  await client.query(
    'DELETE FROM patient_professionals WHERE patient_id = $1',
    [patientId],
  );

  const valid = professionals.filter(p => p.name?.trim());
  if (valid.length === 0) return;

  const encrypted = await Promise.all(
    valid.map(async p => ({
      phoneEnc: await encryptionService.encrypt(p.phone ?? null),
      emailEnc: await encryptionService.encrypt(p.email ?? null),
    })),
  );

  const values: unknown[] = [];
  const placeholders = valid.map((p, i) => {
    const base = i * 6;
    values.push(patientId, p.name, encrypted[i].phoneEnc, encrypted[i].emailEnc, p.displayOrder, p.isTeam ?? false);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  await client.query(
    `INSERT INTO patient_professionals (patient_id, name, phone_encrypted, email_encrypted, display_order, is_team)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
}
