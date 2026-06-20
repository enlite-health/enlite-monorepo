/**
 * WorkerPersonalInfoRepository
 *
 * Extracted from WorkerRepository to stay within the 400-line limit.
 * Contains the updatePersonalInfo method with KMS PII encryption.
 */

import { Pool } from 'pg';
import { Worker, SavePersonalInfoDTO } from '../domain/Worker';
import { WORKER_ERROR_CODES } from '../domain/workerErrors';
import { Result } from '@shared/utils/Result';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';

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
    // normalizeSexValue MUST be called before encrypt AND before bidx so that
    // write-path, filter, and backfill all produce identical HMACs.
    const canonicalSex = normalizeSexValue(data.sex);

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
      sexBidxBuffer,
      languagesBidxBuffers,
    ] = await Promise.all([
      encryptionService.encrypt(data.firstName),
      encryptionService.encrypt(data.lastName),
      encryptionService.encrypt(data.birthDate),
      encryptionService.encrypt(canonicalSex),
      encryptionService.encrypt(data.gender),
      // Quando phone vier vazio (use case decidiu manter o atual), encriptar
      // null para que phone_encrypted seja preservado via COALESCE abaixo.
      encryptionService.encrypt(data.phone || null),
      encryptionService.encrypt(data.documentNumber),
      encryptionService.encrypt(data.profilePhotoUrl),
      encryptionService.encrypt(
        data.languages && data.languages.length > 0 ? JSON.stringify(data.languages) : null,
      ),
      blindIndexService.generateNameTrigramBidx(data.firstName, data.lastName),
      blindIndexService.generateValueBidx(canonicalSex),
      blindIndexService.generateValuesBidx(data.languages ?? []),
    ]);
    const nameBidxLiteral = blindIndexService.serializeForPg(nameBidxBuffers);
    const languagesBidxLiteral = blindIndexService.serializeForPg(languagesBidxBuffers);

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
        phone_encrypted = COALESCE($10, phone_encrypted),
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
        sex_bidx = $23,
        languages_bidx = $24::bytea[],
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
      sexBidxBuffer,
      languagesBidxLiteral,
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return Result.fail<Worker>('Worker not found');
    }

    return Result.ok<Worker>(result.rows[0]);
  } catch (error: any) {
    // Rede de segurança: o use case já evita colisões de telefone, mas se uma
    // escapar (ex.: corrida ou formato inesperado), traduzimos a violação da
    // constraint única para um código de domínio estável — NUNCA vazamos a
    // mensagem crua do Postgres ("duplicate key ... idx_workers_phone_unique")
    // para o cliente.
    if (error?.code === '23505' && error?.constraint === 'idx_workers_phone_unique') {
      return Result.fail<Worker>(WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE);
    }
    return Result.fail<Worker>(`Failed to update personal info: ${error.message}`);
  }
}
