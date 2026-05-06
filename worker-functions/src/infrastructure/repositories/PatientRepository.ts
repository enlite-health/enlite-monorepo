/**
 * @deprecated Use `PatientService` from `src/modules/case` instead.
 * This file is a compatibility shim kept only to avoid breaking any residual
 * callers and to export PatientAddress / PatientProfessional types used by
 * PatientService internally.
 * Will be removed in the next clean-up pass after M138 runs in production.
 *
 * NOTE: responsible_* columns were renamed to responsible_*_deprecated_20260422
 * by migration 137 and removed by migration 138. This shim no longer writes them.
 */
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface PatientAddress {
  addressType: string;         // 'primary' | 'secondary' | 'tertiary'
  addressFormatted?: string | null;  // ClickUp location field (formatted)
  addressRaw?: string | null;        // Domicilio Informado (free text)
  displayOrder: number;
  /** Provincia del paciente (ClickUp: "Provincia del Paciente"). Migration 147. */
  state?: string | null;
  /** Ciudad / Localidad del paciente (ClickUp: "Ciudad / Localidad del Paciente"). Migration 147. */
  city?: string | null;
  /** Zona o Barrio (ClickUp: "Zona o Barrio Paciente", short_text). Migration 147. */
  neighborhood?: string | null;
  /** Latitude geocodificada. Migrated from job_postings.service_lat (migration 153/154). */
  lat?: number | null;
  /** Longitude geocodificada. Migrated from job_postings.service_lng (migration 153/154). */
  lng?: number | null;
}

export interface PatientProfessional {
  name: string;
  phone?: string | null;
  email?: string | null;
  displayOrder: number;
  isTeam?: boolean;  // true = equipo multidisciplinario entry
}

/**
 * @deprecated Fields responsible_* removed from patients table (M137/M138).
 * Use PatientServiceUpsertInput from src/modules/case instead.
 */
export interface PatientClickUpData {
  clickupTaskId: string;

  // Identity
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | null;
  documentType?: string | null;
  documentNumber?: string | null;
  affiliateId?: string | null;
  sex?: string | null;
  phoneWhatsapp?: string | null;

  // Clinical
  diagnosis?: string | null;
  dependencyLevel?: string | null;
  clinicalSegments?: string | null;
  serviceType?: string | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;

  // Insurance
  insuranceInformed?: string | null;
  insuranceVerified?: string | null;

  // General location
  cityLocality?: string | null;
  province?: string | null;
  zoneNeighborhood?: string | null;

  // Related records
  addresses?: PatientAddress[];
  professionals?: PatientProfessional[];

  country?: string;
}

/**
 * @deprecated Use PatientService from src/modules/case.
 */
export class PatientRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  async upsertFromClickUp(data: PatientClickUpData): Promise<{ id: string; created: boolean }> {
    const country = data.country ?? 'AR';

    const result = await this.pool.query<{ id: string; xmax: string }>(
      `INSERT INTO patients (
        clickup_task_id,
        first_name, last_name, birth_date, document_type, document_number,
        affiliate_id, sex, phone_whatsapp,
        diagnosis, dependency_level, clinical_segments, service_type, device_type,
        additional_comments, has_judicial_protection, has_cud, has_consent,
        insurance_informed, insurance_verified,
        city_locality, province, zone_neighborhood,
        country
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
      )
      ON CONFLICT (clickup_task_id) DO UPDATE SET
        first_name              = EXCLUDED.first_name,
        last_name               = EXCLUDED.last_name,
        birth_date              = EXCLUDED.birth_date,
        document_type           = EXCLUDED.document_type,
        document_number         = EXCLUDED.document_number,
        affiliate_id            = EXCLUDED.affiliate_id,
        sex                     = EXCLUDED.sex,
        phone_whatsapp          = EXCLUDED.phone_whatsapp,
        diagnosis               = EXCLUDED.diagnosis,
        dependency_level        = EXCLUDED.dependency_level,
        clinical_segments       = EXCLUDED.clinical_segments,
        service_type            = EXCLUDED.service_type,
        device_type             = EXCLUDED.device_type,
        additional_comments     = EXCLUDED.additional_comments,
        has_judicial_protection = EXCLUDED.has_judicial_protection,
        has_cud                 = EXCLUDED.has_cud,
        has_consent             = EXCLUDED.has_consent,
        insurance_informed      = EXCLUDED.insurance_informed,
        insurance_verified      = EXCLUDED.insurance_verified,
        city_locality           = EXCLUDED.city_locality,
        province                = EXCLUDED.province,
        zone_neighborhood       = EXCLUDED.zone_neighborhood,
        updated_at              = NOW()
      RETURNING id, xmax::text`,
      [
        data.clickupTaskId,
        data.firstName           ?? null,
        data.lastName            ?? null,
        data.birthDate           ?? null,
        data.documentType        ?? null,
        data.documentNumber      ?? null,
        data.affiliateId         ?? null,
        data.sex                 ?? null,
        data.phoneWhatsapp       ?? null,
        data.diagnosis           ?? null,
        data.dependencyLevel     ?? null,
        data.clinicalSegments    ?? null,
        data.serviceType         ?? null,
        data.deviceType          ?? null,
        data.additionalComments      ?? null,
        data.hasJudicialProtection   ?? null,
        data.hasCud                  ?? null,
        data.hasConsent              ?? null,
        data.insuranceInformed       ?? null,
        data.insuranceVerified       ?? null,
        data.cityLocality            ?? null,
        data.province                ?? null,
        data.zoneNeighborhood        ?? null,
        country,
      ],
    );

    const row = result.rows[0];
    const patientId = row.id;
    const created = row.xmax === '0';

    if (data.addresses !== undefined) {
      await this.replaceAddresses(patientId, data.addresses);
    }
    if (data.professionals !== undefined) {
      await this.replaceProfessionals(patientId, data.professionals);
    }

    return { id: patientId, created };
  }

  async replaceAddresses(patientId: string, addresses: PatientAddress[]): Promise<void> {
    await this.pool.query(
      'DELETE FROM patient_addresses WHERE patient_id = $1',
      [patientId],
    );

    const valid = addresses.filter(a => a.addressFormatted || a.addressRaw);
    if (valid.length === 0) return;

    const values: unknown[] = [];
    const placeholders = valid.map((a, i) => {
      const base = i * 5;
      values.push(patientId, a.addressType, a.addressFormatted ?? null, a.addressRaw ?? null, a.displayOrder);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    await this.pool.query(
      `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, display_order)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  async replaceProfessionals(patientId: string, professionals: PatientProfessional[]): Promise<void> {
    await this.pool.query(
      'DELETE FROM patient_professionals WHERE patient_id = $1',
      [patientId],
    );

    const valid = professionals.filter(p => p.name?.trim());
    if (valid.length === 0) return;

    const encrypted = await Promise.all(
      valid.map(async p => ({
        phoneEnc: await this.encryptionService.encrypt(p.phone ?? null),
        emailEnc: await this.encryptionService.encrypt(p.email ?? null),
      })),
    );

    const values: unknown[] = [];
    const placeholders = valid.map((p, i) => {
      const base = i * 6;
      values.push(patientId, p.name, encrypted[i].phoneEnc, encrypted[i].emailEnc, p.displayOrder, p.isTeam ?? false);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    await this.pool.query(
      `INSERT INTO patient_professionals (patient_id, name, phone_encrypted, email_encrypted, display_order, is_team)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}
