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
    // UPDATE PARCIAL — todo campo é gravado com `COALESCE($n, col)`, então um
    // campo ausente/vazio no payload PRESERVA o valor atual em vez de gravar
    // NULL por cima. Isso protege contra o data-loss de "campo some" quando o
    // autosave manda só os campos editados (ou quando um campo vem vazio numa
    // corrida de hidratação). Antes, só `phone` era COALESCE e todo o resto era
    // overwrite cego — qualquer omissão zerava a coluna.
    //
    // Convenção: valor "ausente" = string vazia/undefined (vira NULL antes do
    // encrypt/SQL) ou array vazio. `encrypt(null|'')` já retorna null, então os
    // campos encriptados omitidos caem no COALESCE naturalmente.
    //
    // HIPAA 18 Identifiers: Names, Dates, Phone, Email, Document numbers, Photos,
    // Demographics. normalizeSexValue roda antes de encrypt E de bidx para que
    // write-path, filtro e backfill produzam HMACs idênticos.
    const canonicalSex = data.sex ? normalizeSexValue(data.sex) : null;

    // Blind indexes só são recomputados quando a fonte vem no payload — senão
    // ficam NULL e o COALESCE preserva o índice atual.
    //  - name_trgm_bidx depende de firstName + lastName JUNTOS: regra both-or-
    //    neither (o front sempre envia o par). Com só um dos dois, mantemos o
    //    índice atual em vez de gerar um HMAC parcial/incorreto.
    const hasFullName = Boolean(data.firstName) && Boolean(data.lastName);
    const hasLanguages = Boolean(data.languages && data.languages.length > 0);

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
      encryptionService.encrypt(hasLanguages ? JSON.stringify(data.languages) : null),
      hasFullName
        ? blindIndexService.generateNameTrigramBidx(data.firstName, data.lastName)
        : Promise.resolve(null),
      canonicalSex
        ? blindIndexService.generateValueBidx(canonicalSex)
        : Promise.resolve(null),
      hasLanguages
        ? blindIndexService.generateValuesBidx(data.languages ?? [])
        : Promise.resolve(null),
    ]);
    const nameBidxLiteral = nameBidxBuffers ? blindIndexService.serializeForPg(nameBidxBuffers) : null;
    const languagesBidxLiteral = languagesBidxBuffers
      ? blindIndexService.serializeForPg(languagesBidxBuffers)
      : null;

    const query = `
      UPDATE workers SET
        first_name_encrypted = COALESCE($2, first_name_encrypted),
        last_name_encrypted = COALESCE($3, last_name_encrypted),
        sex_encrypted = COALESCE($4, sex_encrypted),
        gender_encrypted = COALESCE($5, gender_encrypted),
        birth_date_encrypted = COALESCE($6, birth_date_encrypted),
        document_type = COALESCE($7, document_type),
        document_number_encrypted = COALESCE($8, document_number_encrypted),
        phone = COALESCE($9, phone),
        phone_encrypted = COALESCE($10, phone_encrypted),
        profile_photo_url_encrypted = COALESCE($11, profile_photo_url_encrypted),
        languages_encrypted = COALESCE($12, languages_encrypted),
        profession = COALESCE($13, profession),
        knowledge_level = COALESCE($14, knowledge_level),
        title_certificate = COALESCE($15, title_certificate),
        experience_types = COALESCE($16, experience_types),
        years_experience = COALESCE($17, years_experience),
        preferred_types = COALESCE($18, preferred_types),
        preferred_age_range = COALESCE($19, preferred_age_range),
        terms_accepted_at = CASE WHEN $20 THEN NOW() ELSE terms_accepted_at END,
        privacy_accepted_at = CASE WHEN $21 THEN NOW() ELSE privacy_accepted_at END,
        name_trgm_bidx = COALESCE($22::bytea[], name_trgm_bidx),
        sex_bidx = COALESCE($23, sex_bidx),
        languages_bidx = COALESCE($24::bytea[], languages_bidx),
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
