/**
 * PatientDetail — domain entity that mirrors PatientDetailRow from the backend.
 *
 * All date fields arrive as ISO strings over JSON (Date is serialised by
 * JSON.stringify). Consumers parse them with `new Date(value)` if needed.
 */

import type { PatientChatIdMap, PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';
import type { PatientCompleteness } from './PatientCompleteness';
export type { PatientCompleteness, PatientCompletenessCode } from './PatientCompleteness';
// Spec 012 (bloco B): estado v2 / Historial em `PatientLifecycle.ts`, cobertura em
// `PatientCoverage.ts`, logística do endereço em `PatientAddress.ts` — este arquivo já
// batia no teto de 400 linhas do validador.
export type { PatientCoverageSectionPayload } from './PatientCoverage';
export type { UpdatePatientStatusPayload, PatientStatusHistoryEntry } from './PatientLifecycle';
export type { InsuranceProvider } from './PatientCoverage';
export type { PatientCoverageEmergencyContact, PatientCoverageEmergencyContactInput, CoverageEmergencyContactKind } from './PatientCoverage';
import type { PatientCoverageEmergencyContact } from './PatientCoverage';
export type { PatientAddressLogisticsPayload } from './PatientAddress';
export type { PatientKanbanItem, PatientFunnelData } from './PatientLifecycle';
// Só os 2 tipos que algum consumidor importa DAQUI (o resto — payloads de escrita, enums —
// vem direto de `PatientContractedService.ts`; reexportar tudo aqui estourava o teto de 400).
export type { PatientContractedServiceDetail, PatientContractedServiceProvider } from './PatientContractedService';
import type { PatientContractedServiceDetail } from './PatientContractedService';
export interface PatientResponsibleDetail {
  id: string;
  firstName: string | null;
  lastName: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  documentType: string | null;
  documentNumber: string | null;
  isPrimary: boolean;
  displayOrder: number;
  /**
   * Procedência da linha ('clickup' | 'web_form' | 'admin_manual' | …). O
   * drawer da rede de apoio REENVIA este valor: a seção é replace-all e o
   * backend cai em 'clickup' quando ele falta — o que apagaria a amarra entre o
   * dado e o consentimento colhido no formulário público (spec 011 A1, lex C1.2).
   */
  source: string;
}

/**
 * Contato de terceiro SEM vínculo familiar na rede de apoio do paciente (migration 422; spec 018
 * PR-2, `lex` #4): professor, escola, vizinho, empregador, gestor de caso, referente comunitário.
 * SEM categoria de saúde no `relation` (condição do lex).
 */
export interface PatientExternalContactDetail {
  id: string;
  relation: string;
  name: string;
  phone: string | null;
  active: true;
}

/** `patients.emergency_responsible_id` / `emergency_external_contact_id` — migration 423, spec 018 PR-2, D-A. */
export interface EmergencyContactRef {
  kind: 'RESPONSIBLE' | 'EXTERNAL';
  id: string;
}

export interface AddressAvailabilityPerDay {
  dayOfWeek: number;
  coveredHours: number;
  availableRanges: Array<{ start: string; end: string }>;
}

export interface AddressAvailability {
  totalCoveredHours: number;
  maxHours: 168;
  isFull: boolean;
  perDay: AddressAvailabilityPerDay[];
  activeVacanciesCount: number;
  hasUnknownSchedule: boolean;
}

/**
 * Endereço como a API o devolve (`PatientDetailQueryHelper.mapAddresses`).
 * Não existe `fullAddress`/`street`/`city` no contrato: o que há é o texto
 * formatado pelo geocoder e o texto cru do operador (spec 011 A2).
 */
export interface PatientAddressDetail {
  id: string;
  /**
   * Spec 019 (D310 item c, Caminho B — reaproveita `address_type`): lista fechada por
   * parentesco (`PATIENT_ADDRESS_TYPES` em `PatientAddress.ts`) ou `null` = "sin especificar".
   * Deixou de ser posição do slot (`primary`/`secondary`/`service`) — quem marca o principal
   * agora é `isPrimary` (de `is_default`), campo independente.
   */
  addressType: string | null;
  /** Texto livre do "Otro" (≤40) — só coerente quando `addressType === 'otro'` (migration 434). */
  addressTypeOther: string | null;
  addressFormatted: string | null;
  addressRaw: string | null;
  /** Address complement (Depto, Piso, andar). Migration 157. */
  complement: string | null;
  displayOrder: number;
  lat: number | null;
  lng: number | null;
  isPrimary: boolean;
  /** Zona/bairro — coluna `neighborhood` (mig 147; spec 012 lex C2.7: não duplicar). */
  neighborhood: string | null;
  /** Corredor logístico por endereço (mig 316). */
  logisticsCorridor: string | null;
  /** Logística e acesso — texto livre sobre o domicílio (mig 316; `data-clarity-mask` na tela). */
  accessNotes: string | null;
  /** Jurisdição do endereço (mig 316). */
  country: string | null;
  availability?: AddressAvailability;
}

/**
 * Profissional tratante como a API o devolve. `patient_professionals` NÃO tem
 * coluna de especialidade — o que existe é `is_team` (mig 038: a linha
 * representa o equipo multidisciplinar, e `name` é o nome do equipo). Nada
 * aqui é derivado (spec 011 A2, lex C2.2).
 */
export interface PatientProfessionalDetail {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  /** Enum fechado (migration 427, spec 018 PR-5). NULL = legado ou `isTeam` (equipe sem especialidade própria). */
  specialty: import('./patientEnums').PatientProfessionalSpecialtyCode | null;
  displayOrder: number;
  isTeam: boolean;
}

/**
 * Diagnóstico estruturado (spec 016 F2, D263) — a projeção pública `DiagnosisPublicView` do
 * backend (REQ-21): NUNCA carrega `code`/`chapter`/`release`, só o suficiente para a tela
 * mostrar a patología e deixar remover/promover por clique. `uri` é opaco para o cliente — ele
 * só a devolve no POST, nunca a interpreta.
 */
export interface PatientDiagnosisDetail {
  id: string;
  uri: string;
  title: string;
  isPrimary: boolean;
  source: string;
  active: boolean;
}

export interface PatientDetail {
  id: string;
  /** null para paciente NATIVO (criado no painel ou pelo formulário público, mig 251). */
  clickupTaskId: string | null;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null; // ISO string
  documentType: string | null; // 'DNI'|'PASSPORT'|'CEDULA'|'LE_LC'|'CPF'
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null; // 'MALE'|'FEMALE'|'INTERSEX'|'UNDISCLOSED'
  phoneWhatsapp: string | null;
  /** E-mail do paciente (mig 251), descriptografado SÓ no detalhe. null = não informado (spec 011 A4). */
  contactEmail: string | null;
  /**
   * Gênero declarado (spec 018 PR-3, Emenda 13/09, migration 425): FEMALE|MALE|NON_BINARY|OTHER|
   * PREFER_NOT_TO_SAY. `null` = não perguntado, distinto de `'PREFER_NOT_TO_SAY'` (resposta
   * explícita). Coleta SEMPRE facultativa. Opcional: API anterior a esta rodada não manda o campo.
   */
  gender?: string | null;
  /** Idiomas do paciente (spec 018 PR-3): subconjunto fechado de 'pt'|'es'|'en'. `null` = não perguntado. Opcional (idem). */
  languages?: string[] | null;
  /**
   * Spec 018 PR-4 (contracts/patient-header-and-photo.md): tem foto de perfil cadastrada.
   * `null` = sem `patient_identity:read` (nunca `false` nesse caso — não pode vazar "tem foto").
   * Opcional: API anterior a esta rodada não manda o campo.
   */
  hasPhoto?: boolean | null;
  /** Data do último status DISCHARGED (spec 018 PR-3, FR-203/204). `null` = nunca esteve DISCHARGED. Opcional (idem). */
  dischargedAt?: string | null;
  /** chat_id do grupo de WhatsApp da FAMÍLIA no Periskope (@g.us). Migration 260. */
  /**
   * Grupos de WhatsApp do Periskope por PAPEL (migration 261): papel -> chat_id
   * (@g.us). Papel ausente = não vinculado. Catálogo em
   * `@domain/value-objects/patientChatRole`.
   */
  chatIds: PatientChatIdMap;
  /** @deprecated alias de `chatIds.FAMILY`; sai com a migration de contract. */
  familyChatId: string | null;
  /** @deprecated alias de `chatIds.PROVIDERS`; sai com a migration de contract. */
  providersChatId: string | null;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  clinicalSegments: string | null;
  serviceType: string[] | null;
  deviceType: string | null;
  additionalComments: string | null;
  /** Autoria da última edição das observações (REQ-01): ISO e NOME do staff (resolvido no backend). null = nunca editado pelo painel. */
  additionalCommentsUpdatedAt: string | null;
  additionalCommentsUpdatedBy: string | null;
  /** Instruções de emergência (REQ-01 · D211.2). null + redacted=true = o ator não pode ler (ponto único no backend). */
  emergencyInstructions: string | null;
  emergencyInstructionsUpdatedAt: string | null;
  emergencyInstructionsUpdatedBy: string | null;
  emergencyInstructionsRedacted?: boolean;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  /** PatientStatus v2 (spec 012): funil (SOLICITANTE|ADMISSION|PENDING_ADMISSION) ou clínico (ACTIVE|ON_HOLD|SEARCHING|REPLACEMENT|SUSPENDED|DISCHARGED). */
  status: string | null;
  /** Funil de admissão (mig 313): SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE — o Kanban lê isto. */
  admissionStatus: string;
  /** Motivo da espera quando status = ON_HOLD (SCHOOL | INSURER | OTHER). */
  onHoldReason: string | null;
  /** Texto clínico RESTRITO (D211.2): null + onHoldNoteRedacted=true quando o ator não pode ler. */
  onHoldNote: string | null;
  onHoldNoteRedacted?: boolean;
  /** Data de início do serviço (mig 317) — ISO; nativa do painel, não deriva da vaga. */
  serviceStartDate: string | null;
  /** Coberturas verificadas por CÓDIGO do catálogo (mig 312), ordem do catálogo. */
  insuranceVerifiedCodes: string[];
  /**
   * As mesmas coberturas, COM origem (QA 🟡3/SUP-B5) — o drawer usa `source` para travar o chip
   * do ClickUp (não removível) e restringir o multi-select ao que o painel gravou
   * (`source: 'admin_manual'`). Opcional: API anterior a esta rodada não manda o campo.
   */
  insuranceVerifiedEntries?: Array<{ code: string; source: string }>;
  /** Dispositivos — códigos de `device_types` (mig 307), ordem do catálogo. */
  deviceTypes: string[];
  needsAttention: boolean;
  attentionReasons: string[];
  /** Checklist de completude (spec 014 US-D1) — SÓ aqui, nunca na lista/kanban. */
  completeness: PatientCompleteness;
  /** Spec 014 (US-D3): `phoneWhatsapp` coincide com o de um responsável. */
  phoneMatchesResponsible: boolean;
  responsibles: PatientResponsibleDetail[];
  /**
   * Spec 018, PR-2 (`lex` #4): contatos externos sem vínculo familiar (container `patient_family`).
   * `null` = o ator não tem `patient_family:read` (redação, D113); `[]` = tem a célula e a lista está vazia.
   */
  externalContacts?: PatientExternalContactDetail[] | null;
  /**
   * Spec 018, PR-2 (D-A): a marca de emergência do paciente. `null` = não definida OU o ator não
   * tem `patient_family:read` — os dois casos são indistinguíveis de propósito (D113/lex C3).
   */
  emergencyContactRef?: EmergencyContactRef | null;
  /**
   * 417 (D301): contatos de emergência da COBERTURA (container `patient_coverage`). `null` = o ator não
   * tem a célula (redação, D113); `[]` = tem a célula e a lista está vazia. Backend anterior à 417: ausente.
   */
  coverageEmergencyContacts?: PatientCoverageEmergencyContact[] | null;
  /** lex C3: o ator lê a cobertura mas NÃO a equipe — o profissional direto foi RETIDO (a lista acima não é completa). */
  coverageDirectProfessionalRedacted?: boolean | null;
  /** Bulkhead (D167): a leitura dos contatos FALHOU no servidor — não é "sem contatos". */
  coverageEmergencyContactsUnavailable?: boolean | null;
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  /** Serviços contratados (spec 013, bloco C) — contrato do detalhe. */
  contractedServices: PatientContractedServiceDetail[];
  /**
   * Diagnóstico estruturado (spec 016 F2, D263 · correção C5). Bulkhead do backend (C4): uma
   * falha ao ler o catálogo de terminologia NUNCA derruba a ficha inteira — `diagnoses` vem
   * `[]` e `diagnosesUnavailable: true` diz que é "não consegui ler", não "paciente sem
   * diagnóstico" (que é `[]` + `false`). NÃO construir tela sobre isto ainda — é a F3.
   */
  diagnoses: PatientDiagnosisDetail[];
  diagnosesUnavailable: boolean;
  lastCaseNumber?: number | null;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

/**
 * Body for POST /api/admin/patients — manual creation of a native patient by
 * the admission team (Fase 1 Task 2). firstName and country are required; the
 * rest is filled by the team over time. Must mirror the backend zod validator
 * (createPatientSchema) and the CreatePatientUseCase input.
 */
export interface CreatePatientPayload {
  firstName: string;
  /** Required — the backend rejects a body without it (400). Drives admission
   * scheduling AND the legal regime (Ley 25.326 vs LGPD); there is deliberately
   * no default, so a BR patient is never filed as AR (abac-pais-fase1 5.1). */
  country: 'AR' | 'BR';
  lastName?: string;
  /** US-B6 (spec 012): yyyy-MM-dd. */
  birthDate?: string;
  phoneWhatsapp?: string;
  contactEmail?: string;
  documentType?: string; // 'DNI'|'PASSPORT'|'CEDULA'|'LE_LC'|'CPF'
  documentNumber?: string;
  healthInsuranceName?: string;
  healthInsuranceMemberId?: string;
  serviceType?: string[]; // Profession[]: 'AT'|'CAREGIVER'|'NURSE'|'KINESIOLOGIST'|'PSYCHOLOGIST'
}

/** Result of a successful patient creation. */
export interface CreatePatientResult {
  id: string;
}

/** Vacancy summary returned by GET /api/admin/patients/:id/vacancies */
export interface PatientVacancySummary {
  id: string;
  caseNumber: number | null;
  vacancyNumber: number | null;
  title: string | null;
  status: string | null;
  isDraft: boolean;
  createdAt: string;
}

// ============================================================================
// Fase 2b — pipeline de ativação (edição de seções, mudança de status, ativar)
// ============================================================================

// Payloads de seção do PATCH — extraídos em 06/09 (teto de 400 linhas do `validate:lines`).
// Re-exportados aqui para nenhum consumidor precisar mudar de import.
export type {
  PatientSectionName,
  PatientGeneralSectionPayload,
  PatientClinicalSectionPayload,
  PatientResponsibleInput,
  PatientResponsiblePatch,
  PatientServiceSectionPayload,
  PatientSectionPayload,
} from './PatientSectionPayloads';

/**
 * Body de PUT /api/admin/patients/:id/chat-ids — espelha patientChatIdsSchema
 * (backend). `null` DESVINCULA; papel ausente do mapa fica INALTERADO.
 */
export interface PatientChatIdsPayload {
  chatIds: Record<string, string | null>;
}

/** Um grupo do Periskope candidato, já pontuado — GET /:id/chat-candidates. */
export interface PatientChatCandidate {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
  /** 0..1 — semelhança com o nome do paciente. */
  score: number;
  matchedTerms: string[];
  /** true quando o grupo já está preso a OUTRO paciente. */
  linkedToOtherPatient: boolean;
}

export interface PatientChatCandidatesResult {
  candidates: PatientChatCandidate[];
  /**
   * Papel -> os MESMOS `chatId`s de `candidates`, na ordem daquele papel.
   *
   * Só a ORDEM muda entre um papel e outro. Existe porque os dois grupos do
   * mesmo paciente ("Flia. Perez" e "Equipo Perez") têm score IDÊNTICO, e o
   * desempate antigo era alfabético — o que punha o grupo dos prestadores em
   * primeiro nos DOIS seletores. Medido contra o gabarito do Marcel: o grupo da
   * família em 1º lugar subiu de 52,4% para 71,4%, sem tirar ninguém do top 3.
   *
   * Opcional no tipo porque um backend anterior a esta mudança não manda o
   * campo; a tela cai no ranking global nesse caso.
   */
  candidatesByRole?: Record<string, string[]>;
  /** Quantos grupos foram varridos no Periskope. */
  totalGroups: number;
  /**
   * `true` = a lista de grupos veio INCOMPLETA do Periskope. A tela precisa
   * avisar: sem isso o operador lê "nenhum candidato" quando a verdade é que a
   * lista foi cortada antes de chegar no grupo do paciente.
   */
  groupListTruncated?: boolean;
}

/** Uma linha de GET /api/admin/chat-groups — um grupo que a org enxerga. */
export interface ChatGroupListItem {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
  /** De qual número conectado o grupo veio — responde "por que não vejo o meu?". */
  orgPhone: string | null;
  /**
   * Quantos PACIENTES já usam este grupo, em qualquer papel.
   *
   * O que significa depende do papel: num COMPARTILHADO (obra social), 40 é o
   * esperado; num EXCLUSIVO, qualquer número > 0 significa que gravar dará 409.
   */
  linkedPatientCount: number;
}

/** GET /api/admin/chat-groups?search=&limit=&offset= */
export interface ChatGroupsResult {
  groups: ChatGroupListItem[];
  /** Total DEPOIS do filtro de busca. */
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** A varredura do Periskope parou no limite: a lista está incompleta. */
  listTruncated: boolean;
}

/**
 * GET /api/admin/patient-chat-roles — o catálogo.
 * `usage` só vem com `?includeInactive=true` (visão de administração).
 */
export interface PatientChatRolesResult {
  roles: PatientChatRoleSpec[];
  /** Código do papel -> quantos PACIENTES o usam hoje. */
  usage?: Record<string, number>;
}

/** Body de POST /api/admin/patient-chat-roles. */
export interface PatientChatRolePayload {
  code: string;
  labelEs: string;
  labelPtBr: string;
  isExclusive: boolean;
  displayOrder: number;
  matchKeywords: string[];
}

/** Result of PUT /api/admin/patients/:id/status. */
export interface UpdatePatientStatusResult {
  id: string;
  status: string;
}


// `ActivatePatientResult` (POST /:id/activate) SAIU (spec 018, PR-6, ADR-5) — a rota é 410.
// O resultado da ativação por serviço é `ActivateRecruitmentResult`, em
// `@infrastructure/http/AdminContractedServicesApiService`.
