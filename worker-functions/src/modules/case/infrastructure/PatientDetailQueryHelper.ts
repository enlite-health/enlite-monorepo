import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type {
  PatientDetailRow,
  PatientResponsibleDetail,
  PatientAddressDetail,
  PatientProfessionalDetail,
} from './PatientQueryRows';
import { legacyChatIdAliases } from '../domain/PatientChatId';
import {
  computeAddressAvailability,
  type ActiveVacancy,
} from '../application/AddressAvailabilityCalculator';
import { mapContractedServices } from './ContractedServiceDetailMapper';
import { PatientCoverageEmergencyContactRepository, type CoverageEmergencyContactRow } from './PatientCoverageEmergencyContactRepository';
import { PatientExternalContactRepository } from './PatientExternalContactRepository';
import type { EmergencyMarkTarget } from './PatientEmergencyMarkRepository';
import { reportError } from '@shared/logging';
import { ALL_PATIENT_CONTAINERS_READABLE, type PatientContainerReads } from '../application/patientContainerAccess';
import { phoneMatchesResponsible } from '../domain/PhoneMatch';

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
    -- E-mail do paciente (mig 251; spec 011 A4, lex C4.1): cifrado com KMS, sai
    -- SÓ no detalhe — a listagem não seleciona esta coluna. Descriptografado
    -- abaixo, uma chamada por carga de ficha.
    p.contact_email_encrypted AS "contactEmailEncrypted",
    diagnosis,
    dependency_level         AS "dependencyLevel",
    clinical_specialty       AS "clinicalSpecialty",
    clinical_segments        AS "clinicalSegments",
    service_type             AS "serviceType",
    device_type              AS "deviceType",
    additional_comments      AS "additionalComments",
    -- Autoria da última edição das observações (migration 286): data + NOME resolvido
    -- na leitura a partir do uid — o uid não sai da API (lex 29/08, item 3).
    p.additional_comments_updated_at AS "additionalCommentsUpdatedAt",
    (SELECT COALESCE(u.display_name, u.email) FROM users u
      WHERE u.firebase_uid = p.additional_comments_updated_by) AS "additionalCommentsUpdatedBy",
    -- Instruções de emergência (mig 294, D211.2): mesmo molde de autoria; a redação por permissão
    -- acontece DEPOIS, no ponto único (PatientService.redactClinicalForActor).
    p.emergency_instructions AS "emergencyInstructions",
    p.emergency_instructions_updated_at AS "emergencyInstructionsUpdatedAt",
    (SELECT COALESCE(u.display_name, u.email) FROM users u
      WHERE u.firebase_uid = p.emergency_instructions_updated_by) AS "emergencyInstructionsUpdatedBy",
    has_judicial_protection  AS "hasJudicialProtection",
    has_cud                  AS "hasCud",
    has_consent              AS "hasConsent",
    -- Cobertura (spec 011 A3, lex "caminho a"): o painel grava em
    -- health_insurance_name (fill-only no upsert do ClickUp, mig 147) e o
    -- sync do ClickUp SOBRESCREVE insurance_informed com o que o mapper manda —
    -- e ele não manda. Ler só insurance_informed escondia a cobertura gravada;
    -- mover a escrita para lá faria o próximo webhook apagá-la. A ficha lê as
    -- duas; a coluna de origem (ClickUp) tem precedência quando existe.
    COALESCE(p.insurance_informed, p.health_insurance_name) AS "insuranceInformed",
    insurance_verified       AS "insuranceVerified",
    city_locality            AS "cityLocality",
    province,
    zone_neighborhood        AS "zoneNeighborhood",
    country,
    -- Grupos de WhatsApp por PAPEL (migration 261). Agregados aqui em vez de
    -- lidos das colunas fixas da 260, que ficaram sem uso até o contract.
    COALESCE((SELECT jsonb_object_agg(c.role, c.chat_id)
                FROM patient_chat_ids c
               WHERE c.patient_id = p.id), '{}'::jsonb) AS "chatIds",
    status,
    -- Spec 012 (bloco B): funil em coluna própria (313), estado v2 + motivo de espera (314),
    -- data de início do serviço (317). on_hold_note é texto clínico restrito: a redação por
    -- permissão acontece DEPOIS, no ponto único (projectPatientClinicalForActor).
    admission_status         AS "admissionStatus",
    on_hold_reason           AS "onHoldReason",
    p.on_hold_note           AS "onHoldNote",
    service_start_date       AS "serviceStartDate",
    -- Cobertura VERIFICADA por código (312) e dispositivo múltiplo (307): arrays na ordem do catálogo.
    COALESCE((SELECT array_agg(x.provider_code ORDER BY x.sort_order, x.provider_code)
                FROM (SELECT DISTINCT piv.provider_code, ip.sort_order
                        FROM patient_insurance_verified piv
                        JOIN insurance_providers ip ON ip.code = piv.provider_code
                       WHERE piv.patient_id = p.id AND piv.provider_code IS NOT NULL) x), '{}'::text[])
                             AS "insuranceVerifiedCodes",
    -- QA 3 (SUP-B5): a MESMA união, com source -- o drawer usa para travar o chip do ClickUp
    -- (não removível ali) e restringir o multi-select ao que o painel gravou. DISTINCT
    -- (provider_code, source) colapsa 2 raw_labels da MESMA origem que mapeiam pro mesmo
    -- código; a mesma cobertura em origens diferentes vira 2 entradas (é o par que a tela precisa
    -- distinguir).
    COALESCE((SELECT jsonb_agg(jsonb_build_object('code', x.provider_code, 'source', x.source)
                                ORDER BY x.sort_order, x.provider_code, x.source)
                FROM (SELECT DISTINCT piv.provider_code, piv.source, ip.sort_order
                        FROM patient_insurance_verified piv
                        JOIN insurance_providers ip ON ip.code = piv.provider_code
                       WHERE piv.patient_id = p.id AND piv.provider_code IS NOT NULL) x), '[]'::jsonb)
                             AS "insuranceVerifiedEntries",
    COALESCE((SELECT array_agg(pdt.device_type ORDER BY d.sort_order, d.code)
                FROM patient_device_types pdt
                JOIN device_types d ON d.code = pdt.device_type
               WHERE pdt.patient_id = p.id), '{}'::text[])
                             AS "deviceTypes",
    needs_attention          AS "needsAttention",
    attention_reasons        AS "attentionReasons",
    -- Mesma fonte da lista (PatientQueryRepository): usa patients.case_number
    -- e cai no MAX das vagas quando o paciente foi importado sem esse campo.
    -- Sem o COALESCE, um paciente com case_number mas sem vagas não mostrava
    -- o "Caso #N" na ficha (inconsistente com a lista).
    COALESCE(
      p.case_number,
      (SELECT MAX(jp.case_number) FROM job_postings jp WHERE jp.patient_id = p.id AND jp.deleted_at IS NULL)
    )                        AS "lastCaseNumber",
    p.created_at               AS "createdAt",
    p.updated_at               AS "updatedAt",
    -- Marca de emergência (migration 423, spec 018 PR-2, D-A): no máximo 1 das duas é NOT NULL.
    p.emergency_responsible_id      AS "emergencyResponsibleId",
    p.emergency_external_contact_id AS "emergencyExternalContactId"
  FROM patients p
  WHERE p.id = $1
    AND p.deleted_at IS NULL
`;

async function fetchRelated(pool: Pool, patientId: string, enc: KMSEncryptionService) {
  return Promise.all([
    pool.query(
      // `AND active` (spec 018, PR-1, FR-004): a ficha só mostra responsáveis vivos — quem foi
      // desativado pelo painel some daqui, mas continua na tabela (nunca DELETE).
      `SELECT id, first_name, last_name, relationship,
              phone_encrypted, email_encrypted,
              document_number_encrypted, document_type,
              is_primary, display_order, source
         FROM patient_responsibles
        WHERE patient_id = $1 AND active
        ORDER BY display_order ASC, is_primary DESC`,
      [patientId],
    ),
    pool.query(
      // archived_at IS NULL: patient detail shows only active addresses to the
      // operator. Archived rows still exist in the table to preserve historic
      // vacancies that point to them — see migration 198 and
      // docs/features/vacancy-creation/06-endereco-servico.md.
      `SELECT id, address_type, address_formatted, address_raw, complement, display_order, lat, lng,
              neighborhood, logistics_corridor, access_notes, country
         FROM patient_addresses
        WHERE patient_id = $1
          AND archived_at IS NULL
        ORDER BY display_order ASC`,
      [patientId],
    ),
    // `AND active` (migration 420/427, spec 018 PR-5): a ficha só mostra linhas vivas — achado
    // desta execução, a mesma classe do FR-004 que responsibles/coverage já cumprem; sem o filtro,
    // desativar um profissional pelo painel não o tirava da tela.
    pool.query(
      `SELECT id, name, phone_encrypted, email_encrypted, specialty, display_order, is_team
         FROM patient_professionals
        WHERE patient_id = $1 AND active
        ORDER BY display_order ASC`,
      [patientId],
    ),
    // Spec 018, PR-2: contatos externos sem vínculo familiar — `active` sempre filtrado (mesma
    // régua dos responsáveis, FR-004).
    pool.query(
      `SELECT id, relation, name, phone_encrypted, sort_order
         FROM patient_external_contacts
        WHERE patient_id = $1 AND active
        ORDER BY sort_order ASC, created_at ASC`,
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
    // Serviços contratados (spec 013, bloco C) — contrato do detalhe. hourlyValue vem CRU aqui;
    // a redação por papel (lex C-c.4) acontece no controller (ponto único).
    pool.query(`SELECT * FROM patient_contracted_services WHERE patient_id = $1 ORDER BY active DESC, created_at ASC`, [patientId]),
    // 417 (D301): só o ciphertext; decifra depois, e só sob `patient_coverage:read`. Bulkhead (molde dos
    // diagnósticos, D263 C4): a 417 é migration MANUAL em prod e o merge deploya o código — se a tabela ainda
    // não existir, a ficha NÃO cai; o campo sai "indisponível" (D167: não-li ≠ vazio), com erro reportado.
    new PatientCoverageEmergencyContactRepository(pool, enc).fetchRows(patientId, pool).then(
      (rows) => ({ rows, unavailable: false }),
      (err: unknown) => {
        reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PatientDetailQueryHelper:coverageEmergencyContacts', patientId });
        return { rows: [] as CoverageEmergencyContactRow[], unavailable: true };
      },
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
        specialty: pr.specialty ?? null,
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
    // Spec 012, US-B2: logística POR endereço (316); zona = `neighborhood` (147, lex C2.7).
    neighborhood: a.neighborhood ?? null,
    logisticsCorridor: a.logistics_corridor ?? null,
    accessNotes: a.access_notes ?? null,
    country: a.country ?? null,
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
  /**
   * D286 / `lex` P3: a célula decide ANTES de o KMS rodar. Container que o ator não lê não é
   * descriptografado — o texto claro de familiar/equipe/e-mail nunca existe em memória para
   * ele (mesma regra da C3 de prestador). Default = tudo (engine não decidiu → como antes).
   */
  reads: PatientContainerReads = ALL_PATIENT_CONTAINERS_READABLE,
): Promise<PatientDetailRow | null> {
  const patientResult = await pool.query(PATIENT_DETAIL_SQL, [id]);
  if (patientResult.rows.length === 0) return null;

  const p = patientResult.rows[0];
  const [responsibleRows, addressRows, professionalRows, externalContactRows, vacancyRows, contractedServiceRows, coverageContactRows] = await fetchRelated(pool, id, encryptionService);

  const vacancies: ActiveVacancy[] = vacancyRows.rows.map((v: any) => ({
    id: v.id,
    patient_address_id: v.patient_address_id,
    status: v.status,
    schedule: v.schedule,
  }));

  const [responsibles, professionals, externalContacts, contactEmail, contractedServices, coverageEmergencyContacts] = await Promise.all([
    reads.family ? decryptResponsibles(responsibleRows.rows, encryptionService) : Promise.resolve([]),
    reads.careTeam ? decryptProfessionals(professionalRows.rows, encryptionService) : Promise.resolve([]),
    // Spec 018, PR-2: mesma régua dos responsáveis — sem `patient_family:read` o KMS não roda.
    reads.family
      ? new PatientExternalContactRepository(pool, encryptionService).decryptRows(externalContactRows.rows)
      : Promise.resolve([]),
    // Sem ciphertext não há decrypt: o passthrough de teste devolve '' para
    // entrada vazia, e '' na ficha seria "tem e-mail e está em branco".
    reads.identity && p.contactEmailEncrypted ? encryptionService.decrypt(p.contactEmailEncrypted) : Promise.resolve(null),
    reads.services ? mapContractedServices(contractedServiceRows.rows, pool, encryptionService) : Promise.resolve([]),
    // 417 (D301): mesma régua dos responsáveis — sem a célula do container, o KMS não roda. lex C3: o
    // profissional direto é o MESMO dado da equipe tratante (`patient_care_team`): só sai (e só decifra)
    // quando o ator lê os DOIS containers — cobertura e equipe.
    reads.coverage
      ? new PatientCoverageEmergencyContactRepository(pool, encryptionService).decryptRows(
          coverageContactRows.rows.filter((r) => r.kind !== 'DIRECT_PROFESSIONAL' || reads.careTeam),
        )
      : Promise.resolve([]),
  ]);

  // Marca de emergência (spec 018, PR-2, D-A): não vaza QUAL contato é o marcado sem `patient_family:read`.
  const emergencyContactRef: EmergencyMarkTarget = reads.family
    ? p.emergencyResponsibleId
      ? { kind: 'RESPONSIBLE', id: p.emergencyResponsibleId }
      : p.emergencyExternalContactId
        ? { kind: 'EXTERNAL', id: p.emergencyExternalContactId }
        : null
    : null;

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
    contactEmail,
    diagnosis: p.diagnosis,
    dependencyLevel: p.dependencyLevel,
    clinicalSpecialty: p.clinicalSpecialty,
    clinicalSegments: p.clinicalSegments,
    serviceType: p.serviceType,
    deviceType: p.deviceType,
    additionalComments: p.additionalComments,
    additionalCommentsUpdatedAt: p.additionalCommentsUpdatedAt,
    additionalCommentsUpdatedBy: p.additionalCommentsUpdatedBy,
    emergencyInstructions: p.emergencyInstructions,
    emergencyInstructionsUpdatedAt: p.emergencyInstructionsUpdatedAt,
    emergencyInstructionsUpdatedBy: p.emergencyInstructionsUpdatedBy,
    hasJudicialProtection: p.hasJudicialProtection,
    hasCud: p.hasCud,
    hasConsent: p.hasConsent,
    insuranceInformed: p.insuranceInformed,
    insuranceVerified: p.insuranceVerified,
    cityLocality: p.cityLocality,
    province: p.province,
    zoneNeighborhood: p.zoneNeighborhood,
    country: p.country,
    chatIds: p.chatIds ?? {},
    ...legacyChatIdAliases(p.chatIds ?? {}),
    status: p.status,
    admissionStatus: p.admissionStatus ?? 'DONE',
    onHoldReason: p.onHoldReason ?? null,
    onHoldNote: p.onHoldNote ?? null,
    serviceStartDate: p.serviceStartDate ?? null,
    insuranceVerifiedCodes: p.insuranceVerifiedCodes ?? [],
    insuranceVerifiedEntries: p.insuranceVerifiedEntries ?? [],
    deviceTypes: p.deviceTypes ?? [],
    needsAttention: p.needsAttention,
    attentionReasons: p.attentionReasons ?? [],
    // Spec 014 (US-D3, lex D3.1): `phone_whatsapp` do paciente coincide (últimos 8 dígitos) com
    // o telefone de ALGUM responsável — o front mostra o aviso de re-atribuição antes do rename
    // "Teléfono del Responsable"→"WhatsApp del paciente" virar definitivo para este registro.
    phoneMatchesResponsible: phoneMatchesResponsible(p.phoneWhatsapp, responsibles.map((r) => r.phone)),
    lastCaseNumber: p.lastCaseNumber != null ? Number(p.lastCaseNumber) : null,
    responsibles,
    externalContacts,
    emergencyContactRef,
    coverageEmergencyContacts,
    // Marcador CONSTANTE (não depende de haver linha): com cobertura mas sem equipe, o profissional direto
    // foi retido — a tela e o PDF dizem isso em vez de mostrar a lista como se fosse completa.
    coverageDirectProfessionalRedacted: reads.coverage && !reads.careTeam,
    coverageEmergencyContactsUnavailable: coverageContactRows.unavailable,
    addresses,
    professionals,
    contractedServices,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
