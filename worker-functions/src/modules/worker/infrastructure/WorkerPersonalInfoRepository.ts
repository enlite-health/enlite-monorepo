/**
 * WorkerPersonalInfoRepository
 *
 * Extracted from WorkerRepository to stay within the 400-line limit.
 * Contains the updatePersonalInfo method with KMS PII encryption.
 */

import { Pool } from 'pg';
import { Worker, SavePersonalInfoDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';

export async function updatePersonalInfo(
  pool: Pool,
  encryptionService: KMSEncryptionService,
  blindIndexService: BlindIndexService,
  data: Omit<SavePersonalInfoDTO, 'termsAccepted' | 'privacyAccepted'> & {
    termsAccepted: boolean;
    privacyAccepted: boolean;
  },
): Promise<Result<Worker>> {
  try {
    // Criptografar TODOS os campos sensíveis (PHI/PII) com KMS em paralelo
    // HIPAA 18 Identifiers: Names, Dates, Phone, Email, Document numbers, Photos, Demographics
    const [
      encryptedFirstName,
      encryptedLastName,
      encryptedBirthDate,
      encryptedSex,
      encryptedGender,
      encryptedPhone,
      encryptedDocumentNumber,
      encryptedPhotoUrl,
      encryptedLanguages,
      nameBidxBuffers,
    ] = await Promise.all([
      encryptionService.encrypt(data.firstName),
      encryptionService.encrypt(data.lastName),
      encryptionService.encrypt(data.birthDate),
      encryptionService.encrypt(data.sex),
      encryptionService.encrypt(data.gender),
      encryptionService.encrypt(data.phone),
      encryptionService.encrypt(data.documentNumber),
      encryptionService.encrypt(data.profilePhotoUrl),
      encryptionService.encrypt(
        data.languages && data.languages.length > 0 ? JSON.stringify(data.languages) : null,
      ),
      blindIndexService.generateNameTrigramBidx(data.firstName, data.lastName),
    ]);
    const nameBidxLiteral = blindIndexService.serializeForPg(nameBidxBuffers);

    const query = `
      UPDATE workers SET
        first_name_encrypted = $2,
        last_name_encrypted = $3,
        sex_encrypted = $4,
        gender_encrypted = $5,
        birth_date_encrypted = $6,
        document_type = $7,
        document_number_encrypted = $8,
        phone = COALESCE($9, phone),
        phone_encrypted = $10,
        profile_photo_url_encrypted = $11,
        languages_encrypted = $12,
        profession = $13,
        knowledge_level = $14,
        title_certificate = $15,
        experience_types = $16,
        years_experience = $17,
        preferred_types = $18,
        preferred_age_range = $19,
        terms_accepted_at = CASE WHEN $20 THEN NOW() ELSE terms_accepted_at END,
        privacy_accepted_at = CASE WHEN $21 THEN NOW() ELSE privacy_accepted_at END,
        name_trgm_bidx = $22::bytea[],
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        auth_uid as "authUid",
        first_name_encrypted as "firstNameEncrypted",
        last_name_encrypted as "lastNameEncrypted",
        sex_encrypted as "sexEncrypted",
        gender_encrypted as "genderEncrypted",
        birth_date_encrypted as "birthDateEncrypted",
        document_type as "documentType",
        document_number_encrypted as "documentNumberEncrypted",
        phone_encrypted as "phoneEncrypted",
        profile_photo_url_encrypted as "profilePhotoUrlEncrypted",
        languages_encrypted as "languagesEncrypted",
        profession,
        knowledge_level as "knowledgeLevel",
        title_certificate as "titleCertificate",
        experience_types as "experienceTypes",
        years_experience as "yearsExperience",
        preferred_types as "preferredTypes",
        preferred_age_range as "preferredAgeRange",
        country,
        terms_accepted_at as "termsAcceptedAt",
        privacy_accepted_at as "privacyAcceptedAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;

    const values = [
      data.workerId,
      encryptedFirstName,
      encryptedLastName,
      encryptedSex,
      encryptedGender,
      encryptedBirthDate,
      data.documentType,
      encryptedDocumentNumber,
      data.phone || null,
      encryptedPhone,
      encryptedPhotoUrl,
      encryptedLanguages,
      data.profession,
      data.knowledgeLevel,
      data.titleCertificate,
      data.experienceTypes,
      data.yearsExperience,
      data.preferredTypes,
      data.preferredAgeRange,
      data.termsAccepted,
      data.privacyAccepted,
      nameBidxLiteral,
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return Result.fail<Worker>('Worker not found');
    }

    return Result.ok<Worker>(result.rows[0]);
  } catch (error: any) {
    return Result.fail<Worker>(`Failed to update personal info: ${error.message}`);
  }
}
