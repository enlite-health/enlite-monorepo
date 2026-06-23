import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

/**
 * Lê e descriptografa as colunas auditáveis de um worker para montar o "antes"
 * do diff de auditoria. Chaves espelham os nomes de campo usados em
 * `fieldsUpdated` do UpdateWorkerProfileFieldsUseCase.
 */
export async function captureWorkerBefore(
  pool: Pool,
  enc: KMSEncryptionService,
  workerId: string,
): Promise<Record<string, unknown>> {
  const res = await pool.query(
    `SELECT email, document_type, profession,
            occupation, knowledge_level, title_certificate, years_experience,
            experience_types, preferred_types, preferred_age_range,
            first_name_encrypted, last_name_encrypted, birth_date_encrypted,
            document_number_encrypted, languages_encrypted, linkedin_url_encrypted
     FROM workers WHERE id = $1`,
    [workerId],
  );
  const r = res.rows[0];
  if (!r) return {};

  const [firstName, lastName, birthDate, documentNumber, linkedinUrl, languagesRaw] = await Promise.all([
    enc.decrypt(r.first_name_encrypted ?? ''),
    enc.decrypt(r.last_name_encrypted ?? ''),
    enc.decrypt(r.birth_date_encrypted ?? ''),
    enc.decrypt(r.document_number_encrypted ?? ''),
    enc.decrypt(r.linkedin_url_encrypted ?? ''),
    enc.decrypt(r.languages_encrypted ?? ''),
  ]);

  let languages: unknown = null;
  if (languagesRaw) {
    try { languages = JSON.parse(languagesRaw); } catch { languages = languagesRaw; }
  }

  const before: Record<string, unknown> = {
    email: r.email ?? null,
    documentType: r.document_type ?? null,
    profession: r.profession ?? null,
    occupation: r.occupation ?? null,
    knowledgeLevel: r.knowledge_level ?? null,
    titleCertificate: r.title_certificate ?? null,
    yearsExperience: r.years_experience ?? null,
    experienceTypes: r.experience_types ?? null,
    preferredTypes: r.preferred_types ?? null,
    preferredAgeRange: r.preferred_age_range ?? null,
    firstName: firstName || null,
    lastName: lastName || null,
    birthDate: birthDate || null,
    documentNumber: documentNumber || null,
    linkedinUrl: linkedinUrl || null,
    languages,
  };
  // cpf/rg compartilham a coluna de documento
  before.cpf = before.documentNumber;
  before.rg = before.documentNumber;
  return before;
}
