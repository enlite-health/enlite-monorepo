import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { GCSStorageService } from '../../infrastructure/GCSStorageService';
import { mapPlatformLabel } from './AdminWorkersControllerHelpers';
import { WorkerApplicationRepository } from '../../../matching/infrastructure/WorkerApplicationRepository';
import { BlockedApplicationQueryRepository } from '../../../matching/infrastructure/BlockedApplicationQueryRepository';
import { WorkerEngagement } from '../../../matching/domain/WorkerEngagement';
import { NOME_REDIGIDO } from '@modules/identity/permissions';
import { projectPatientNameInEngagement, workerContainerReadsOf, workerRedactionMarker } from '../../application/workerContainerAccess';

/**
 * Funções auxiliares para montar a resposta completa de detalhe de um worker.
 * Extraídas de AdminWorkersController para manter o arquivo dentro do limite de 400 linhas.
 */

export async function toSignedUrl(gcs: GCSStorageService, filePath: string | null, workerId: string): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await gcs.generateViewSignedUrl(filePath, workerId);
  } catch (err) {
    // Hotfix 13/09 (rodada 2, R4): NUNCA loga o filePath nem `err.message`
    // — a mensagem de erro do GCS pode carregar o nome do objeto (o próprio
    // filePath rejeitado). Só o workerId dono e o NOME DA CLASSE do erro
    // (ex.: "DocumentPathOwnershipError", "Error") — o suficiente para
    // diagnosticar sem vazar caminho.
    const errorClass = err instanceof Error ? err.constructor.name : typeof err;
    console.error('[AdminWorkersDetailBuilder] Failed to sign URL for worker:', workerId, '| errorClass:', errorClass);
    return null;
  }
}

export async function buildDocumentsWithSignedUrls(gcs: GCSStorageService, doc: any, workerId: string) {
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
    ...paths.map((p: string | null) => toSignedUrl(gcs, p, workerId)),
    ...additionalPaths.map((p: string) => toSignedUrl(gcs, p, workerId)),
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
 * Monta a ficha completa de um prestador, PROJETADA pelas células do ator (D286 fase 2).
 * Compartilhado por getWorkerById e getWorkerByPhone.
 *
 * ⚠️ A célula decide ANTES de o KMS rodar (C3 da F2): cada `decrypt` só é chamado no ramo que a
 * célula autoriza. `cells = null` (engine não decidiu — família fora do rollout, principal de
 * serviço, engine desligado) devolve a ficha inteira, byte a byte como antes (D113).
 */
export async function buildWorkerDetailResponse(
  db: Pool,
  encryptionService: KMSEncryptionService,
  gcs: GCSStorageService,
  w: Record<string, any>,
  cells: readonly string[] | null = null,
): Promise<Record<string, any>> {
  const appRepo = new WorkerApplicationRepository();
  const blockedRepo = new BlockedApplicationQueryRepository();
  const reads = workerContainerReadsOf(cells);
  const abrir = (autorizado: boolean, valor: string | null | undefined): Promise<string | null> =>
    autorizado ? encryptionService.decrypt(valor) : Promise.resolve(null);

  const [
    firstName, lastName, birthDate, sex, gender, documentNumber,
    profilePhotoUrl, languages, whatsappPhone, linkedinUrl,
    sexualOrientation, race, religion, weightKg, heightCm,
    docsResult, serviceAreasResult, locationResult, engagements, availabilityResult, tagsResult,
  ] = await Promise.all([
    abrir(reads.contact, w.first_name_encrypted),
    abrir(reads.contact, w.last_name_encrypted),
    abrir(reads.dossier, w.birth_date_encrypted),
    abrir(reads.dossier, w.sex_encrypted),
    abrir(reads.dossier, w.gender_encrypted),
    abrir(reads.dossier, w.document_number_encrypted),
    abrir(reads.dossier, w.profile_photo_url_encrypted),
    // Idiomas: coluna cifrada em repouso que SAI no nível base (`worker:read`), por decisão
    // registrada (`lex` fase 2, condição 3): é critério de matching (paciente que fala X) e o card
    // de perfil profissional os mostra; o proxy de origem étnica que o `lex` aponta fica anotado
    // aqui como risco aceito, não como esquecimento.
    encryptionService.decrypt(w.languages_encrypted),
    abrir(reads.contact, w.whatsapp_phone_encrypted),
    abrir(reads.contact, w.linkedin_url_encrypted),
    abrir(reads.dossier, w.sexual_orientation_encrypted),
    abrir(reads.dossier, w.race_encrypted),
    abrir(reads.dossier, w.religion_encrypted),
    abrir(reads.dossier, w.weight_kg_encrypted),
    abrir(reads.dossier, w.height_cm_encrypted),
    // Documentos: sem a célula a query nem roda — a URL assinada é o dado, e ela só nasce aqui.
    reads.documents
      ? db.query(
          `SELECT id, resume_cv_url, identity_document_url, identity_document_back_url,
            criminal_record_url, professional_registration_url, liability_insurance_url,
            monotributo_certificate_url, at_certificate_url,
            additional_certificates_urls, documents_status, document_validations,
            review_notes, reviewed_by, reviewed_at, submitted_at
          FROM worker_documents WHERE worker_id = $1`,
          [w.id],
        )
      : Promise.resolve({ rows: [] as any[] }),
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
    // Engajamentos do worker = WJA (com stage → coluna do Kanban) ∪ tentativas
    // bloqueadas não-promovidas. Espelha o Kanban da vaga: a aba de encuadre passa a
    // mostrar TODAS as vagas (bloqueado/iniciado/rejeitado inclusive), com o status =
    // coluna do board. SSOT do mapa (stage,source)→coluna: domain/kanbanColumn.ts.
    // Sem `match:read` o bloco não é nem consultado.
    (async (): Promise<WorkerEngagement[] | null> => {
      if (!reads.encuadres) return null;
      const [wjaEngagements, blockedEngagements] = await Promise.all([
        appRepo.listEngagementsByWorker(w.id),
        blockedRepo.listByWorker(w.id),
      ]);
      return [...wjaEngagements, ...blockedEngagements].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt),
      );
    })(),
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
  // Endereço é célula própria (`worker_address:read`, a mesma do mapa): linha, lat/lng e raio
  // (coordenada É o endereço — `lex` fase 2, P2). Cidade, zona de trabalho e zona de interesse
  // são o critério operacional de matching e ficam no nível base.
  const endereco = (valor: string | null | undefined): string | null => (reads.address ? valor ?? null : null);
  const redacted = workerRedactionMarker(reads);

  return {
    id: w.id,
    // Contato: nome, e-mail, telefone, whatsapp, linkedin. Sem a célula o nome vem como
    // `NOME_REDIGIDO` — trava, não rótulo (D181): vazio some da tela e parece cadastro furado.
    email: reads.contact ? w.email : null,
    phone: reads.contact ? w.phone ?? null : null,
    whatsappPhone: whatsappPhone ?? null,
    country: w.country, timezone: w.timezone, status: w.status,
    dataSources: w.data_sources ?? [], platform: mapPlatformLabel(w.data_sources ?? []),
    createdAt: w.created_at, updatedAt: w.updated_at,
    firstName: reads.contact ? firstName ?? null : NOME_REDIGIDO,
    lastName: lastName ?? null, sex: sex ?? null,
    gender: gender ?? null, birthDate: birthDate ?? null,
    documentType: reads.dossier ? w.document_type ?? null : null, documentNumber: documentNumber ?? null,
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
    isTest: w.is_test ?? false,
    // Espelho AnaCare (migrations 014/231) — status de sincronização do worker com
    // o AnaCare. Usado pelo synthetic monitoring (e2e-prod) para provar via HTTP
    // que um worker is_test não foi espelhado (anaCareId null).
    anaCareId: w.ana_care_id ?? null,
    anaCareSyncedAt: w.ana_care_synced_at ?? null,
    documents: doc ? await buildDocumentsWithSignedUrls(gcs, doc, w.id) : null,
    serviceAreas: reads.address ? serviceAreasResult.rows.map((sa: any) => ({
      id: sa.id, address: sa.address_line ?? null, serviceRadiusKm: sa.radius_km ?? null,
      lat: sa.latitude ? parseFloat(sa.latitude) : null,
      lng: sa.longitude ? parseFloat(sa.longitude) : null,
    })) : null,
    location: loc ? {
      address: endereco(loc.address), city: loc.city ?? null,
      workZone: loc.work_zone ?? null, interestZone: loc.interest_zone ?? null,
    } : null,
    // Uma linha por vaga em que o worker está engajado. `kanbanStage` é a coluna do
    // Kanban (SSOT deriveKanbanColumn) — o frontend renderiza o label de
    // admin.kanban.columns.<kanbanStage>. Mantém o nome `encuadres` no payload por
    // retrocompat do WorkerDetail (frontend WorkerEncuadresCard). `null` (não `[]`) sem a
    // célula: `[]` diria "não está em nenhuma vaga", e o ator não pode saber nem isso.
    encuadres: engagements === null ? null : engagements.map((e: WorkerEngagement) => ({
      id: e.id, jobPostingId: e.jobPostingId, caseNumber: e.caseNumber, vacancyNumber: e.vacancyNumber,
      // Nome do PACIENTE — outro titular, célula de identidade do paciente (D286 fase 1).
      patientName: projectPatientNameInEngagement(e.patientName, reads),
      kanbanStage: e.kanbanStage, vacancyStatus: e.vacancyStatus,
      resultado: e.resultado, interviewDate: e.interviewDate, interviewTime: e.interviewTime,
      recruiterName: e.recruiterName, coordinatorName: e.coordinatorName,
      rejectionReason: e.rejectionReason, rejectionReasonCategory: e.rejectionReasonCategory,
      attended: e.attended, isBlocked: e.isBlocked, blockedReason: e.blockedReason,
      missingFields: e.missingFields, attemptCount: e.attemptCount, createdAt: e.createdAt,
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
    // Marcador CONSTANTE de redação — só aparece quando algo foi redigido (resposta de quem lê
    // tudo é a de antes).
    ...(redacted ? { redacted } : {}),
  };
}
