/**
 * Pure functions for auth-related worker queries/updates.
 * Delegated from WorkerRepository to keep that file under 400 lines.
 */
import { Pool } from 'pg';
import { Worker } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';

// ─── findByAuthUid ────────────────────────────────────────────────────────────

export async function findByAuthUid(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  authUid: string,
): Promise<Result<Worker | null>> {
  try {
    const query = `
      SELECT
        w.id, w.auth_uid as "authUid", w.email, w.phone,
        w.whatsapp_phone_encrypted as "whatsappPhoneEnc",
        w.lgpd_consent_at as "lgpdConsentAt",
        w.first_name_encrypted as "firstNameEnc",
        w.last_name_encrypted as "lastNameEnc",
        w.sex_encrypted as "sexEnc",
        w.gender_encrypted as "genderEnc",
        w.birth_date_encrypted as "birthDateEnc",
        w.document_type as "documentType",
        w.document_number_encrypted as "documentNumberEnc",
        w.profile_photo_url_encrypted as "profilePhotoUrlEnc",
        w.languages_encrypted as "languagesEnc",
        w.profession, w.knowledge_level as "knowledgeLevel",
        w.title_certificate as "titleCertificate",
        w.experience_types as "experienceTypes",
        w.years_experience as "yearsExperience",
        w.preferred_types as "preferredTypes",
        w.preferred_age_range as "preferredAgeRange",
        w.country, w.timezone,
        w.created_at as "createdAt", w.updated_at as "updatedAt",
        sa.address_line as "serviceAddress",
        sa.address_complement as "serviceAddressComplement",
        sa.city as "serviceCity", sa.state as "serviceState",
        sa.country as "serviceCountry", sa.postal_code as "servicePostalCode",
        sa.radius_km as "serviceRadiusKm",
        sa.latitude as "serviceLat", sa.longitude as "serviceLng",
        sa.neighborhood as "serviceNeighborhood"
      FROM workers w
      LEFT JOIN worker_service_areas sa ON sa.worker_id = w.id
      WHERE w.auth_uid = $1
      GROUP BY w.id, sa.id
    `;

    const result = await pool.query(query, [authUid]);

    if (result.rows.length === 0) {
      return Result.ok<Worker | null>(null);
    }

    const row = result.rows[0];

    // Descriptografar todos os campos PII/PHI em paralelo
    const [firstName, lastName, sex, gender, birthDateStr, documentNumber, profilePhotoUrl, languagesStr, whatsappPhone] =
      await Promise.all([
        encryptionService.decrypt(row.firstNameEnc || ''),
        encryptionService.decrypt(row.lastNameEnc || ''),
        encryptionService.decrypt(row.sexEnc || ''),
        encryptionService.decrypt(row.genderEnc || ''),
        encryptionService.decrypt(row.birthDateEnc || ''),
        encryptionService.decrypt(row.documentNumberEnc || ''),
        encryptionService.decrypt(row.profilePhotoUrlEnc || ''),
        encryptionService.decrypt(row.languagesEnc || ''),
        encryptionService.decrypt(row.whatsappPhoneEnc || ''),
      ]);

    const worker = {
      id: row.id, authUid: row.authUid, email: row.email,
      phone: row.phone || undefined,
      whatsappPhone: whatsappPhone || undefined,
      lgpdConsentAt: row.lgpdConsentAt || undefined,
      firstName: firstName || undefined, lastName: lastName || undefined,
      sex: sex || undefined, gender: gender || undefined,
      birthDate: birthDateStr ? new Date(birthDateStr) : undefined,
      documentType: row.documentType || undefined,
      documentNumber: documentNumber || undefined,
      profilePhotoUrl: profilePhotoUrl || undefined,
      languages: languagesStr ? JSON.parse(languagesStr) : [],
      profession: row.profession || undefined,
      knowledgeLevel: row.knowledgeLevel || undefined,
      titleCertificate: row.titleCertificate || undefined,
      experienceTypes: row.experienceTypes || [],
      yearsExperience: row.yearsExperience || undefined,
      preferredTypes: row.preferredTypes || [],
      preferredAgeRange: row.preferredAgeRange || [],
      country: row.country, timezone: row.timezone,
      createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
      serviceAddress: row.serviceAddress || undefined,
      serviceAddressComplement: row.serviceAddressComplement || undefined,
      serviceCity: row.serviceCity || undefined,
      serviceState: row.serviceState || undefined,
      serviceCountry: row.serviceCountry || undefined,
      servicePostalCode: row.servicePostalCode || undefined,
      serviceRadiusKm: row.serviceRadiusKm || undefined,
      serviceLat: row.serviceLat != null ? parseFloat(row.serviceLat) : undefined,
      serviceLng: row.serviceLng != null ? parseFloat(row.serviceLng) : undefined,
      serviceNeighborhood: row.serviceNeighborhood || undefined,
      availability: row.availability || [],
    };

    return Result.ok<Worker>(worker as unknown as Worker);
  } catch (error: any) {
    return Result.fail<Worker | null>(`Failed to find worker: ${error.message}`);
  }
}

// ─── updateAuthUid ────────────────────────────────────────────────────────────

export async function updateAuthUid(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  workerId: string,
  authUid: string,
  phone?: string,
  consentAt?: Date,
): Promise<Result<Worker>> {
  try {
    const setClauses: string[] = ['auth_uid = $1', 'updated_at = NOW()'];
    const params: unknown[] = [authUid];

    if (phone) {
      // Normaliza phone na borda do update para manter unicidade semântica.
      const normalizedPhone = normalizePhoneAR(phone) || phone;
      params.push(normalizedPhone);
      setClauses.push(`phone = $${params.length}`);
    }

    if (consentAt) {
      params.push(consentAt);
      const idx = params.length;
      setClauses.push(`lgpd_consent_at = COALESCE(lgpd_consent_at, $${idx})`);
      setClauses.push(`terms_accepted_at = COALESCE(terms_accepted_at, $${idx})`);
      setClauses.push(`privacy_accepted_at = COALESCE(privacy_accepted_at, $${idx})`);
    }

    params.push(workerId);
    const whereIdx = params.length;

    const query = `
      UPDATE workers
      SET ${setClauses.join(', ')}
      WHERE id = $${whereIdx}
      RETURNING id, auth_uid as "authUid", email, phone,
                whatsapp_phone_encrypted as "whatsappPhoneEnc",
                lgpd_consent_at as "lgpdConsentAt",
                country, timezone, status,
                created_at as "createdAt", updated_at as "updatedAt"`;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return Result.fail<Worker>('Worker not found');
    }

    const row = result.rows[0];
    row.whatsappPhone = (await encryptionService.decrypt(row.whatsappPhoneEnc)) || undefined;
    delete row.whatsappPhoneEnc;

    return Result.ok<Worker>(row);
  } catch (error: any) {
    return Result.fail<Worker>(`Failed to update worker auth_uid: ${error.message}`);
  }
}

// ─── updateImportedWorkerData ─────────────────────────────────────────────────

export async function updateImportedWorkerData(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  workerId: string,
  data: { authUid: string; email: string; consentAt?: Date },
): Promise<Result<Worker>> {
  try {
    const setClauses: string[] = ['auth_uid = $1', 'email = $2', 'updated_at = NOW()'];
    const params: unknown[] = [data.authUid, data.email];

    if (data.consentAt) {
      params.push(data.consentAt);
      const idx = params.length;
      setClauses.push(`lgpd_consent_at = COALESCE(lgpd_consent_at, $${idx})`);
      setClauses.push(`terms_accepted_at = COALESCE(terms_accepted_at, $${idx})`);
      setClauses.push(`privacy_accepted_at = COALESCE(privacy_accepted_at, $${idx})`);
    }

    params.push(workerId);
    const whereIdx = params.length;

    const query = `
      UPDATE workers
      SET ${setClauses.join(', ')}
      WHERE id = $${whereIdx}
      RETURNING id, auth_uid as "authUid", email, phone,
                whatsapp_phone_encrypted as "whatsappPhoneEnc",
                lgpd_consent_at as "lgpdConsentAt",
                country, timezone, status,
                created_at as "createdAt", updated_at as "updatedAt"
    `;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return Result.fail<Worker>('Worker not found');
    }

    const row = result.rows[0];
    row.whatsappPhone = (await encryptionService.decrypt(row.whatsappPhoneEnc)) || undefined;
    delete row.whatsappPhoneEnc;

    return Result.ok<Worker>(row);
  } catch (error: any) {
    return Result.fail<Worker>(`Failed to update imported worker: ${error.message}`);
  }
}
