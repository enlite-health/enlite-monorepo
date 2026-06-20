import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { GCSStorageService } from '../../infrastructure/GCSStorageService';
import { mapPlatformLabel } from './AdminWorkersControllerHelpers';

/**
 * Funções auxiliares para montar a resposta completa de detalhe de um worker.
 * Extraídas de AdminWorkersController para manter o arquivo dentro do limite de 400 linhas.
 */

export async function toSignedUrl(gcs: GCSStorageService, filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await gcs.generateViewSignedUrl(filePath);
  } catch {
    console.error('[AdminWorkersDetailBuilder] Failed to sign URL for:', filePath);
    return null;
  }
}

export async function buildDocumentsWithSignedUrls(gcs: GCSStorageService, doc: any) {
  const paths = [
    doc.resume_cv_url,
    doc.identity_document_url,
    doc.identity_document_back_url,
    doc.criminal_record_url,
    doc.professional_registration_url,
    doc.liability_insurance_url,
    doc.monotributo_certificate_url,
    doc.at_certificate_url,
  ];
  const additionalPaths: string[] = doc.additional_certificates_urls ?? [];

  const [
    resumeCvUrl, identityDocumentUrl, identityDocumentBackUrl, criminalRecordUrl,
    professionalRegistrationUrl, liabilityInsuranceUrl,
    monotributoCertificateUrl, atCertificateUrl,
    ...additionalCertificatesUrls
  ] = await Promise.all([
    ...paths.map((p: string | null) => toSignedUrl(gcs, p)),
    ...additionalPaths.map((p: string) => toSignedUrl(gcs, p)),
  ]);

  const rawValidations: Record<string, { validated_by: string; validated_at: string }> | null =
    doc.document_validations ?? null;
  const documentValidations: Record<string, { validatedBy: string; validatedAt: string }> = {};
  if (rawValidations) {
    for (const [key, val] of Object.entries(rawValidations)) {
      documentValidations[key] = { validatedBy: val.validated_by, validatedAt: val.validated_at };
    }
  }

  return {
    id: doc.id, resumeCvUrl, identityDocumentUrl, identityDocumentBackUrl,
    criminalRecordUrl, professionalRegistrationUrl, liabilityInsuranceUrl,
    monotributoCertificateUrl, atCertificateUrl,
    additionalCertificatesUrls: additionalCertificatesUrls.filter(Boolean) as string[],
    documentsStatus: doc.documents_status ?? 'pending',
    reviewNotes: doc.review_notes ?? null, reviewedBy: doc.reviewed_by ?? null,
    reviewedAt: doc.reviewed_at ?? null, submittedAt: doc.submitted_at ?? null,
    documentValidations,
  };
}

/**
 * Descriptografa PII e busca dados relacionados do worker, montando o objeto de resposta completo.
 * Compartilhado por getWorkerById e getWorkerByPhone.
 */
export async function buildWorkerDetailResponse(
  db: Pool,
  encryptionService: KMSEncryptionService,
  gcs: GCSStorageService,
  w: Record<string, any>,
): Promise<Record<string, any>> {
  const [
    firstName, lastName, birthDate, sex, gender, documentNumber,
    profilePhotoUrl, languages, whatsappPhone, linkedinUrl,
    sexualOrientation, race, religion, weightKg, heightCm,
    docsResult, serviceAreasResult, locationResult, encuadresResult, availabilityResult, tagsResult,
  ] = await Promise.all([
    encryptionService.decrypt(w.first_name_encrypted),
    encryptionService.decrypt(w.last_name_encrypted),
    encryptionService.decrypt(w.birth_date_encrypted),
    encryptionService.decrypt(w.sex_encrypted),
    encryptionService.decrypt(w.gender_encrypted),
    encryptionService.decrypt(w.document_number_encrypted),
    encryptionService.decrypt(w.profile_photo_url_encrypted),
    encryptionService.decrypt(w.languages_encrypted),
    encryptionService.decrypt(w.whatsapp_phone_encrypted),
    encryptionService.decrypt(w.linkedin_url_encrypted),
    encryptionService.decrypt(w.sexual_orientation_encrypted),
    encryptionService.decrypt(w.race_encrypted),
    encryptionService.decrypt(w.religion_encrypted),
    encryptionService.decrypt(w.weight_kg_encrypted),
    encryptionService.decrypt(w.height_cm_encrypted),
    db.query(
      `SELECT id, resume_cv_url, identity_document_url, identity_document_back_url,
        criminal_record_url, professional_registration_url, liability_insurance_url,
        monotributo_certificate_url, at_certificate_url,
        additional_certificates_urls, documents_status, document_validations,
        review_notes, reviewed_by, reviewed_at, submitted_at
      FROM worker_documents WHERE worker_id = $1`,
      [w.id],
    ),
    db.query(
      `SELECT id, address_line, latitude, longitude, radius_km, city, work_zone, interest_zone
         FROM worker_service_areas
        WHERE worker_id = $1 AND deleted_at IS NULL`,
      [w.id],
    ),
    // Mantida como query separada (mesma fonte agora) para preservar shape do
    // builder downstream — `loc` espelha o primeiro service_area do worker.
    db.query(
      `SELECT address_line AS address, city, work_zone, interest_zone
         FROM worker_service_areas
        WHERE worker_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [w.id],
    ),
    db.query(
      `SELECT e.id, e.job_posting_id, jp.case_number, jp.vacancy_number,
        p.first_name AS patient_first_name, p.last_name AS patient_last_name,
        e.resultado, e.interview_date, e.interview_time,
        e.recruiter_name, e.coordinator_name,
        e.rejection_reason, e.rejection_reason_category, e.attended, e.created_at
      FROM encuadres e
      LEFT JOIN job_postings jp ON e.job_posting_id = jp.id
      LEFT JOIN patients p ON jp.patient_id = p.id
      WHERE e.worker_id = $1 ORDER BY e.created_at DESC`,
      [w.id],
    ),
    db.query(
      `SELECT id, day_of_week, start_time, end_time, timezone, crosses_midnight
      FROM worker_availability WHERE worker_id = $1
      ORDER BY day_of_week ASC, start_time ASC`,
      [w.id],
    ),
    db.query(
      `SELECT c.id, c.name, c.color, c.description
         FROM worker_tags wt
         JOIN worker_tag_catalog c ON c.id = wt.tag_id
        WHERE wt.worker_id = $1
          AND c.deleted_at IS NULL
        ORDER BY c.name ASC`,
      [w.id],
    ),
  ]);

  let parsedLanguages: string[] = [];
  if (languages) {
    try { parsedLanguages = JSON.parse(languages); } catch { parsedLanguages = [languages]; }
  }

  const isMatchable = w.status === 'REGISTERED' && w.deleted_at === null;
  const isActive = w.status !== 'DISABLED' && w.deleted_at === null;
  const doc = docsResult.rows[0] ?? null;
  const loc = locationResult.rows[0] ?? null;

  return {
    id: w.id, email: w.email, phone: w.phone ?? null, whatsappPhone: whatsappPhone ?? null,
    country: w.country, timezone: w.timezone, status: w.status,
    dataSources: w.data_sources ?? [], platform: mapPlatformLabel(w.data_sources ?? []),
    createdAt: w.created_at, updatedAt: w.updated_at,
    firstName: firstName ?? null, lastName: lastName ?? null, sex: sex ?? null,
    gender: gender ?? null, birthDate: birthDate ?? null,
    documentType: w.document_type ?? null, documentNumber: documentNumber ?? null,
    profilePhotoUrl: profilePhotoUrl ?? null, profession: w.profession ?? null,
    occupation: w.occupation ?? null, knowledgeLevel: w.knowledge_level ?? null,
    titleCertificate: w.title_certificate ?? null,
    experienceTypes: w.experience_types ?? [], yearsExperience: w.years_experience ?? null,
    preferredTypes: w.preferred_types ?? [], preferredAgeRange: w.preferred_age_range ?? [],
    languages: parsedLanguages, sexualOrientation: sexualOrientation ?? null,
    race: race ?? null, religion: religion ?? null,
    weightKg: weightKg ?? null, heightCm: heightCm ?? null,
    hobbies: w.hobbies ?? [], diagnosticPreferences: w.diagnostic_preferences ?? [],
    linkedinUrl: linkedinUrl ?? null, isMatchable, isActive,
    documents: doc ? await buildDocumentsWithSignedUrls(gcs, doc) : null,
    serviceAreas: serviceAreasResult.rows.map((sa: any) => ({
      id: sa.id, address: sa.address_line ?? null, serviceRadiusKm: sa.radius_km ?? null,
      lat: sa.latitude ? parseFloat(sa.latitude) : null,
      lng: sa.longitude ? parseFloat(sa.longitude) : null,
    })),
    location: loc ? {
      address: loc.address ?? null, city: loc.city ?? null,
      workZone: loc.work_zone ?? null, interestZone: loc.interest_zone ?? null,
    } : null,
    encuadres: encuadresResult.rows.map((e: any) => ({
      id: e.id, jobPostingId: e.job_posting_id ?? null, caseNumber: e.case_number ?? null, vacancyNumber: e.vacancy_number ?? null,
      patientName: [e.patient_first_name, e.patient_last_name].filter(Boolean).join(' ') || null,
      resultado: e.resultado ?? null, interviewDate: e.interview_date ?? null,
      interviewTime: e.interview_time ?? null, recruiterName: e.recruiter_name ?? null,
      coordinatorName: e.coordinator_name ?? null, rejectionReason: e.rejection_reason ?? null,
      rejectionReasonCategory: e.rejection_reason_category ?? null,
      attended: e.attended ?? null, createdAt: e.created_at,
    })),
    availability: availabilityResult.rows.map((a: any) => ({
      id: a.id,
      dayOfWeek: a.day_of_week,
      startTime: a.start_time,
      endTime: a.end_time,
      timezone: a.timezone,
      crossesMidnight: a.crosses_midnight,
    })),
    tags: tagsResult.rows.map((t: any) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      description: t.description ?? undefined,
    })),
  };
}
