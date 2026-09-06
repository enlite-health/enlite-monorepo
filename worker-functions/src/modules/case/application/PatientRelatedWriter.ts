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
  // Versioning strategy (introduced 2026-05-26, migration 198):
  //
  // We merge by (patient_id, display_order) for ACTIVE rows
  // (archived_at IS NULL). When the operator updates the address in ClickUp,
  // the new `address_formatted` may differ from the existing one. We then:
  //
  //   1. If the existing row has the SAME `address_formatted` as the incoming
  //      data — UPDATE in-place. This covers refreshes (geocoding,
  //      neighborhood/city/state correction) that do NOT change the street
  //      address. Vacancies that point to this row are unaffected.
  //
  //   2. If the existing row has a DIFFERENT `address_formatted` — VERSION it:
  //      mark the existing row `archived_at = NOW()` and INSERT a new row with
  //      the same `display_order` carrying the new content. Vacancies pointing
  //      to the archived row are intentionally PRESERVED — they continue
  //      showing the address that was chosen at vacancy-creation time. The new
  //      vacancy form will pick up the new row (filtered by archived_at IS
  //      NULL).
  //
  //   3. If the existing row's `display_order` is no longer present in the
  //      ClickUp payload — archive it (don't delete) when it's referenced by
  //      any job_posting, otherwise hard-delete. This protects against the
  //      ON DELETE RESTRICT trap.
  const valid = addresses.filter(a => a.addressFormatted || a.addressRaw);

  //  4. `logistics_corridor` e `access_notes` (migration 316) NÃO vêm do ClickUp: são digitados
  //     no painel, por endereço. O Path 2 arquiva a linha e insere outra — sem copiá-los, todo
  //     `taskUpdated` de paciente com vaga publicada os apagava em silêncio (não é preciso nem
  //     mudar a rua: `publishedReference` sozinho força o Path 2). `country` sobrevive pelo
  //     trigger da 316; estes dois não têm trigger nenhum, então a cópia é aqui.
  const { rows: existing } = await client.query<{
    id: string;
    display_order: number;
    address_formatted: string | null;
    logistics_corridor: string | null;
    access_notes: string | null;
  }>(
    `SELECT id, display_order, address_formatted, logistics_corridor, access_notes
       FROM patient_addresses
      WHERE patient_id = $1
        AND archived_at IS NULL`,
    [patientId],
  );
  const existingByOrder = new Map<number, { id: string; address_formatted: string | null; logistics_corridor: string | null; access_notes: string | null }>(
    existing.map(r => [r.display_order, { id: r.id, address_formatted: r.address_formatted, logistics_corridor: r.logistics_corridor, access_notes: r.access_notes }]),
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
    const existingForSlot = existingByOrder.get(a.displayOrder);

    const incomingFormatted = a.addressFormatted ?? null;
    const currentFormatted  = existingForSlot?.address_formatted ?? null;
    const formattedChanged  = existingForSlot !== undefined && incomingFormatted !== currentFormatted;

    // Force versioning when a PUBLISHED (is_draft=false) vacancy depends on
    // this row, even if address_formatted is unchanged. This preserves the
    // address snapshot for published vacancies — the operator who created and
    // published the vacancy keeps seeing exactly the address that was active
    // at publish time. Drafts still pick up the refresh (see remap below).
    let publishedReference = false;
    if (existingForSlot) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_postings
          WHERE patient_address_id = $1
            AND is_draft = false
            AND deleted_at IS NULL`,
        [existingForSlot.id],
      );
      publishedReference = parseInt(rows[0].count, 10) > 0;
    }

    if (existingForSlot && !formattedChanged && !publishedReference) {
      // Path 1: UPDATE in-place (no street change, no published vacancy
      // depends on this row). Cheapest path — geocoding refresh.
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
          existingForSlot.id,
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
      continue;
    }

    if (existingForSlot && (formattedChanged || publishedReference)) {
      // Path 2: VERSION — archive the old, insert the new. Triggered by
      // street change OR by snapshot protection for published vacancies.
      await client.query(
        `UPDATE patient_addresses SET archived_at = NOW() WHERE id = $1`,
        [existingForSlot.id],
      );
    }

    // Path 2 (continued) or Path 3 (no existing row in this slot): INSERT new.
    // Logística e acesso viajam da linha ARQUIVADA para a nova (ver nota 4 acima). Slot novo
    // (Path 3) não tem de onde copiar e nasce NULL, que é o correto — não havia dado.
    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO patient_addresses
         (patient_id, address_type, address_formatted, address_raw,
          display_order, state, city, neighborhood, lat, lng,
          logistics_corridor, access_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
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
        existingForSlot?.logistics_corridor ?? null,
        existingForSlot?.access_notes ?? null,
      ],
    );
    const newAddressId = insertRes.rows[0].id;

    // Remap DRAFT vacancies that pointed to the archived row → new row.
    // Drafts haven't been published yet, so they should reflect the latest
    // address. Published vacancies keep pointing to the archived row.
    if (existingForSlot) {
      await client.query(
        `UPDATE job_postings
            SET patient_address_id = $1
          WHERE patient_address_id = $2
            AND is_draft = true
            AND deleted_at IS NULL`,
        [newAddressId, existingForSlot.id],
      );
      // Migration 330: o serviço contratado aponta para o endereço como a vaga aponta — a linha
      // versionada leva o ponteiro junto, senão o serviço ficaria preso ao endereço ARQUIVADO e o
      // checklist acusaria SERVICE_ADDRESS num paciente que só teve o endereço regeocodificado.
      await client.query(
        `UPDATE patient_contracted_services
            SET address_id = $1
          WHERE address_id = $2`,
        [newAddressId, existingForSlot.id],
      );
    }
  }

  // Slots that disappeared from the ClickUp payload:
  //   - archive if referenced by any job_posting OR contracted service (preserve history;
  //     migration 330 — the service FK has no ON DELETE, so a DELETE here would fail)
  //   - delete if orphan
  const newOrders = new Set(geocoded.map(g => g.address.displayOrder));
  const goneIds = existing
    .filter(r => !newOrders.has(r.display_order))
    .map(r => r.id);

  if (goneIds.length > 0) {
    await client.query(
      `UPDATE patient_addresses
          SET archived_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND archived_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM job_postings jp
              WHERE jp.patient_address_id = patient_addresses.id
            )
            OR EXISTS (
              SELECT 1 FROM patient_contracted_services pcs
              WHERE pcs.address_id = patient_addresses.id
            )
          )`,
      [goneIds],
    );
    await client.query(
      `DELETE FROM patient_addresses
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM job_postings jp
            WHERE jp.patient_address_id = patient_addresses.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM patient_contracted_services pcs
            WHERE pcs.address_id = patient_addresses.id
          )`,
      [goneIds],
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
