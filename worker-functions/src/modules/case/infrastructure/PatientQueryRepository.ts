import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { fetchPatientDetail } from './PatientDetailQueryHelper';
import type { AdminPatientsListParams } from '../interfaces/validators/adminPatientsListSchema';

// ── Detail types ──────────────────────────────────────────────────────────────

export interface PatientResponsibleDetail {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string | null;
  /** Decrypted phone or null if absent/encrypted. */
  phone: string | null;
  /** Decrypted email or null if absent/encrypted. */
  email: string | null;
  /** Decrypted document number or null. */
  documentNumber: string | null;
  documentType: string | null;
  isPrimary: boolean;
  displayOrder: number;
  source: string;
}

export interface PatientAddressDetail {
  id: string;
  addressType: string;
  addressFormatted: string | null;
  addressRaw: string | null;
  /** Address complement (Depto, Piso, andar). Manual UI entry. Migration 157. */
  complement: string | null;
  displayOrder: number;
  /** Latitude geocodificada. Migrated from job_postings.service_lat (migration 153/154). */
  lat: number | null;
  /** Longitude geocodificada. Migrated from job_postings.service_lng (migration 153/154). */
  lng: number | null;
  /** True when address_type === 'primary'. */
  isPrimary: boolean;
  /** Computed availability for this address based on active vacancies. */
  availability: import('../application/AddressAvailabilityCalculator').AddressAvailability;
}

export interface PatientProfessionalDetail {
  id: string;
  name: string;
  /** Decrypted phone or null. */
  phone: string | null;
  /** Decrypted email or null. */
  email: string | null;
  displayOrder: number;
  isTeam: boolean;
}

export interface PatientDetailRow {
  // Identity
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null;
  phoneWhatsapp: string | null;
  // Clinical
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  clinicalSegments: string | null;
  serviceType: string[] | null;
  deviceType: string | null;
  additionalComments: string | null;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
  // Coverage
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  // Location
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  // Status / flags
  status: string | null;
  needsAttention: boolean;
  attentionReasons: string[];
  // Related
  responsibles: PatientResponsibleDetail[];
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  /** Last case_number across all job_postings for this patient (null if none). */
  lastCaseNumber: number | null;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}

export interface PatientListRow {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  serviceType: string[] | null;
  documentType: string | null;
  documentNumber: string | null;
  sex: string | null;
  needsAttention: boolean;
  attentionReasons: string[];
  /** Number of addresses linked to this patient. */
  addressesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PatientStatsRow {
  total: number;
  complete: number;
  needsAttention: number;
  createdToday: number;
  createdYesterday: number;
  createdLast7Days: number;
}

/**
 * PatientQueryRepository — read-only queries for admin patient listing and detail.
 *
 * Kept separate from PatientIdentityRepository to respect
 * single-responsibility: identity repo owns upsert/findById; this repo
 * owns list/stats queries that cross identity + clinical columns.
 *
 * findDetailById also decrypts PII from patient_responsibles and
 * patient_professionals using KMSEncryptionService (passthrough in test env).
 */
export class PatientQueryRepository {
  private pool: Pool;
  private readonly encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  async list(
    filters: AdminPatientsListParams,
  ): Promise<{ rows: PatientListRow[]; total: number }> {
    const params: unknown[] = [];
    let i = 1;

    // $1 search term (null = no filter)
    params.push(filters.search?.trim() || null);
    const searchIdx = i++;

    // $2 needs_attention boolean (null = no filter)
    const needsAttentionBool =
      filters.needs_attention === 'true'
        ? true
        : filters.needs_attention === 'false'
          ? false
          : null;
    params.push(needsAttentionBool);
    const needsAttentionIdx = i++;

    // $3 attention_reason string (null = no filter)
    params.push(filters.attention_reason ?? null);
    const attentionReasonIdx = i++;

    // $4 clinical_specialty (null = no filter)
    params.push(filters.clinical_specialty ?? null);
    const clinicalSpecialtyIdx = i++;

    // $5 dependency_level (null = no filter)
    params.push(filters.dependency_level ?? null);
    const dependencyLevelIdx = i++;

    // $6 limit, $7 offset
    params.push(filters.limit);
    const limitIdx = i++;
    params.push(filters.offset);
    const offsetIdx = i++;

    const sql = `
      SELECT
        id,
        clickup_task_id        AS "clickupTaskId",
        first_name             AS "firstName",
        last_name              AS "lastName",
        diagnosis,
        dependency_level       AS "dependencyLevel",
        clinical_specialty     AS "clinicalSpecialty",
        service_type           AS "serviceType",
        document_type          AS "documentType",
        document_number        AS "documentNumber",
        sex,
        needs_attention        AS "needsAttention",
        attention_reasons      AS "attentionReasons",
        (SELECT COUNT(*) FROM patient_addresses pa WHERE pa.patient_id = p.id)::int
                               AS "addressesCount",
        created_at             AS "createdAt",
        updated_at             AS "updatedAt",
        COUNT(*) OVER()        AS total_count
      FROM patients p
      WHERE
        ($${searchIdx}::text IS NULL
          OR p.first_name    ILIKE '%' || $${searchIdx} || '%'
          OR p.last_name     ILIKE '%' || $${searchIdx} || '%'
          OR p.document_number ILIKE '%' || $${searchIdx} || '%')
        AND ($${needsAttentionIdx}::boolean IS NULL OR p.needs_attention = $${needsAttentionIdx})
        AND ($${attentionReasonIdx}::text IS NULL OR $${attentionReasonIdx} = ANY(p.attention_reasons))
        AND ($${clinicalSpecialtyIdx}::text IS NULL OR p.clinical_specialty = $${clinicalSpecialtyIdx})
        AND ($${dependencyLevelIdx}::text IS NULL OR p.dependency_level = $${dependencyLevelIdx})
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const result = await this.pool.query(sql, params);

    const total =
      result.rows.length > 0
        ? parseInt(result.rows[0].total_count as string, 10)
        : 0;

    const rows: PatientListRow[] = result.rows.map((row) => ({
      id: row.id,
      clickupTaskId: row.clickupTaskId,
      firstName: row.firstName,
      lastName: row.lastName,
      diagnosis: row.diagnosis,
      dependencyLevel: row.dependencyLevel,
      clinicalSpecialty: row.clinicalSpecialty,
      serviceType: row.serviceType,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      sex: row.sex,
      needsAttention: row.needsAttention,
      attentionReasons: row.attentionReasons ?? [],
      addressesCount: parseInt(row.addressesCount as unknown as string, 10) || 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return { rows, total };
  }

  async stats(): Promise<PatientStatsRow> {
    const result = await this.pool.query<{
      total: string;
      complete: string;
      needs_attention: string;
      created_today: string;
      created_yesterday: string;
      created_last_7_days: string;
    }>(`
      SELECT
        COUNT(*)::int                                                                 AS total,
        COUNT(*) FILTER (WHERE needs_attention = false)::int                         AS complete,
        COUNT(*) FILTER (WHERE needs_attention = true)::int                          AS needs_attention,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int          AS created_today,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('day', NOW() - INTERVAL '1 day')
            AND created_at <  date_trunc('day', NOW())
        )::int                                                                       AS created_yesterday,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int        AS created_last_7_days
      FROM patients
    `);

    const row = result.rows[0];
    return {
      total: parseInt(row.total, 10),
      complete: parseInt(row.complete, 10),
      needsAttention: parseInt(row.needs_attention, 10),
      createdToday: parseInt(row.created_today, 10),
      createdYesterday: parseInt(row.created_yesterday, 10),
      createdLast7Days: parseInt(row.created_last_7_days, 10),
    };
  }

  /** Full patient detail with decrypted PII. Delegates to PatientDetailQueryHelper. */
  async findDetailById(id: string): Promise<PatientDetailRow | null> {
    return fetchPatientDetail(this.pool, this.encryptionService, id);
  }
}
