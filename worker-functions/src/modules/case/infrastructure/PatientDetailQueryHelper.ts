import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type {
  PatientDetailRow,
  PatientResponsibleDetail,
  PatientAddressDetail,
  PatientProfessionalDetail,
} from './PatientQueryRepository';
import {
  computeAddressAvailability,
  type AddressAvailability,
  type ActiveVacancy,
} from '../application/AddressAvailabilityCalculator';

const PATIENT_DETAIL_SQL = `
  SELECT
    id,
    clickup_task_id          AS "clickupTaskId",
    first_name               AS "firstName",
    last_name                AS "lastName",
    birth_date               AS "birthDate",
    document_type            AS "documentType",
    document_number          AS "documentNumber",
    affiliate_id             AS "affiliateId",
    sex,
    phone_whatsapp           AS "phoneWhatsapp",
    diagnosis,
    dependency_level         AS "dependencyLevel",
    clinical_specialty       AS "clinicalSpecialty",
    clinical_segments        AS "clinicalSegments",
    service_type             AS "serviceType",
    device_type              AS "deviceType",
    additional_comments      AS "additionalComments",
    has_judicial_protection  AS "hasJudicialProtection",
    has_cud                  AS "hasCud",
    has_consent              AS "hasConsent",
    insurance_informed       AS "insuranceInformed",
    insurance_verified       AS "insuranceVerified",
    city_locality            AS "cityLocality",
    province,
    zone_neighborhood        AS "zoneNeighborhood",
    country,
    status,
    needs_attention          AS "needsAttention",
    attention_reasons        AS "attentionReasons",
    (SELECT MAX(jp.case_number) FROM job_postings jp WHERE jp.patient_id = p.id AND jp.deleted_at IS NULL)
                             AS "lastCaseNumber",
    p.created_at               AS "createdAt",
    p.updated_at               AS "updatedAt"
  FROM patients p
  WHERE p.id = $1
`;

async function fetchRelated(pool: Pool, patientId: string) {
  return Promise.all([
    pool.query(
      `SELECT id, first_name, last_name, relationship,
              phone_encrypted, email_encrypted,
              document_number_encrypted, document_type,
              is_primary, display_order, source
         FROM patient_responsibles
        WHERE patient_id = $1
        ORDER BY display_order ASC, is_primary DESC`,
      [patientId],
    ),
    pool.query(
      `SELECT id, address_type, address_formatted, address_raw, complement, display_order, lat, lng
         FROM patient_addresses
        WHERE patient_id = $1
        ORDER BY display_order ASC`,
      [patientId],
    ),
    pool.query(
      `SELECT id, name, phone_encrypted, email_encrypted, display_order, is_team
         FROM patient_professionals
        WHERE patient_id = $1
        ORDER BY display_order ASC`,
      [patientId],
    ),
    // Active vacancies for addresses of this patient (for availability computation)
    pool.query(
      `SELECT jp.id, jp.patient_address_id, jp.status, jp.schedule
         FROM job_postings jp
         JOIN patient_addresses pa ON jp.patient_address_id = pa.id
        WHERE pa.patient_id = $1
          AND jp.status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE','ACTIVE')
          AND jp.deleted_at IS NULL`,
      [patientId],
    ),
  ]);
}

async function decryptResponsibles(
  rows: any[],
  enc: KMSEncryptionService,
): Promise<PatientResponsibleDetail[]> {
  return Promise.all(
    rows.map(async (r) => {
      const [phone, email, documentNumber] = await Promise.all([
        enc.decrypt(r.phone_encrypted),
        enc.decrypt(r.email_encrypted),
        enc.decrypt(r.document_number_encrypted),
      ]);
      return {
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        relationship: r.relationship,
        phone,
        email,
        documentNumber,
        documentType: r.document_type,
        isPrimary: r.is_primary,
        displayOrder: r.display_order,
        source: r.source,
      };
    }),
  );
}

async function decryptProfessionals(
  rows: any[],
  enc: KMSEncryptionService,
): Promise<PatientProfessionalDetail[]> {
  return Promise.all(
    rows.map(async (pr) => {
      const [phone, email] = await Promise.all([
        enc.decrypt(pr.phone_encrypted),
        enc.decrypt(pr.email_encrypted),
      ]);
      return {
        id: pr.id,
        name: pr.name,
        phone,
        email,
        displayOrder: pr.display_order,
        isTeam: pr.is_team ?? false,
      };
    }),
  );
}

function mapAddresses(rows: any[], vacancyRows: ActiveVacancy[]): PatientAddressDetail[] {
  return rows.map((a) => ({
    id: a.id,
    addressType: a.address_type,
    addressFormatted: a.address_formatted,
    addressRaw: a.address_raw,
    complement: a.complement ?? null,
    displayOrder: a.display_order,
    lat: a.lat != null ? parseFloat(a.lat) : null,
    lng: a.lng != null ? parseFloat(a.lng) : null,
    isPrimary: a.address_type === 'primary',
    availability: computeAddressAvailability(a.id, vacancyRows),
  }));
}

/**
 * Fetches full patient detail including related responsibles, addresses and
 * treating professionals, with PII decrypted via KMS.
 * Extracted from PatientQueryRepository to keep that file ≤ 400 lines.
 */
export async function fetchPatientDetail(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  id: string,
): Promise<PatientDetailRow | null> {
  const patientResult = await pool.query(PATIENT_DETAIL_SQL, [id]);
  if (patientResult.rows.length === 0) return null;

  const p = patientResult.rows[0];
  const [responsibleRows, addressRows, professionalRows, vacancyRows] = await fetchRelated(pool, id);

  const vacancies: ActiveVacancy[] = vacancyRows.rows.map((v: any) => ({
    id: v.id,
    patient_address_id: v.patient_address_id,
    status: v.status,
    schedule: v.schedule,
  }));

  const [responsibles, professionals] = await Promise.all([
    decryptResponsibles(responsibleRows.rows, encryptionService),
    decryptProfessionals(professionalRows.rows, encryptionService),
  ]);

  const addresses = mapAddresses(addressRows.rows, vacancies);

  return {
    id: p.id,
    clickupTaskId: p.clickupTaskId,
    firstName: p.firstName,
    lastName: p.lastName,
    birthDate: p.birthDate,
    documentType: p.documentType,
    documentNumber: p.documentNumber,
    affiliateId: p.affiliateId,
    sex: p.sex,
    phoneWhatsapp: p.phoneWhatsapp,
    diagnosis: p.diagnosis,
    dependencyLevel: p.dependencyLevel,
    clinicalSpecialty: p.clinicalSpecialty,
    clinicalSegments: p.clinicalSegments,
    serviceType: p.serviceType,
    deviceType: p.deviceType,
    additionalComments: p.additionalComments,
    hasJudicialProtection: p.hasJudicialProtection,
    hasCud: p.hasCud,
    hasConsent: p.hasConsent,
    insuranceInformed: p.insuranceInformed,
    insuranceVerified: p.insuranceVerified,
    cityLocality: p.cityLocality,
    province: p.province,
    zoneNeighborhood: p.zoneNeighborhood,
    country: p.country,
    status: p.status,
    needsAttention: p.needsAttention,
    attentionReasons: p.attentionReasons ?? [],
    lastCaseNumber: p.lastCaseNumber != null ? Number(p.lastCaseNumber) : null,
    responsibles,
    addresses,
    professionals,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
