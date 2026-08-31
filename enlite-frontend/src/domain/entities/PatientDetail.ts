/**
 * PatientDetail — domain entity that mirrors PatientDetailRow from the backend.
 *
 * All date fields arrive as ISO strings over JSON (Date is serialised by
 * JSON.stringify). Consumers parse them with `new Date(value)` if needed.
 */

import type { PatientChatIdMap, PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';

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

export interface PatientAddressDetail {
  id: string;
  street: string | null;
  number: string | null;
  /** Address complement (Depto, Piso, andar). Migration 157. */
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zipCode: string | null;
  fullAddress: string | null;
  // Extended fields for vacancy creation form
  lat?: number | null;
  lng?: number | null;
  isPrimary?: boolean;
  availability?: AddressAvailability;
}

export interface PatientProfessionalDetail {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  specialty: string | null;
}

export interface PatientDetail {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null; // ISO string
  documentType: string | null; // 'DNI'|'PASSPORT'|'CEDULA'|'LE_LC'|'CPF'
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null; // 'MALE'|'FEMALE'|'INTERSEX'|'UNDISCLOSED'
  phoneWhatsapp: string | null;
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
  status: string | null; // 'PENDING_ADMISSION'|'ACTIVE'|'SUSPENDED'|'DISCONTINUED'|'DISCHARGED'
  needsAttention: boolean;
  attentionReasons: string[];
  responsibles: PatientResponsibleDetail[];
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  lastCaseNumber?: number | null;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

/**
 * Body for POST /api/admin/patients — manual creation of a native patient by
 * the admission team (Fase 1 Task 2). Only firstName is required; the rest is
 * filled by the team over time. Must mirror the backend zod validator
 * (createPatientSchema) and the CreatePatientUseCase input.
 */
export interface CreatePatientPayload {
  firstName: string;
  lastName?: string;
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

/** Section names accepted by PATCH /api/admin/patients/:id/:section. */
export type PatientSectionName = 'general' | 'clinical' | 'support-network' | 'service';

/**
 * section = 'general' — identity fields. Mirrors generalSectionSchema (backend).
 * Every field is a partial update; `null` explicitly clears a nullable column.
 */
export interface PatientGeneralSectionPayload {
  firstName?: string;
  lastName?: string | null;
  birthDate?: string | null; // yyyy-MM-dd (backend coerces to Date)
  documentType?: string | null;
  documentNumber?: string | null;
  sex?: string | null;
  phoneWhatsapp?: string | null;
  contactEmail?: string | null;
}

/** section = 'clinical' — mirrors clinicalSectionSchema (backend). */
export interface PatientClinicalSectionPayload {
  diagnosis?: string | null;
  dependencyLevel?: string | null;
  clinicalSpecialty?: string | null;
  serviceType?: string[] | null;
  deviceType?: string | null;
  additionalComments?: string | null;
  emergencyInstructions?: string | null;
  hasJudicialProtection?: boolean | null;
  hasCud?: boolean | null;
  hasConsent?: boolean | null;
}

/** One responsible in the support-network replace payload. */
export interface PatientResponsibleInput {
  firstName: string;
  lastName: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  isPrimary: boolean;
  displayOrder: number;
}

/** section = 'support-network' — replaces the whole responsibles set. */
export interface PatientSupportNetworkSectionPayload {
  responsibles: PatientResponsibleInput[];
}

/** section = 'service' — targeted service_type update. */
export interface PatientServiceSectionPayload {
  serviceType?: string[] | null;
}

export type PatientSectionPayload =
  | PatientGeneralSectionPayload
  | PatientClinicalSectionPayload
  | PatientSupportNetworkSectionPayload
  | PatientServiceSectionPayload;

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

/** Result of POST /api/admin/patients/:id/activate. */
export interface ActivatePatientResult {
  patientId: string;
  status: string; // always 'ACTIVE'
  createdVacancyIds: string[];
}

/** Row shape used by the patient kanban board (grouped by status). */
export interface PatientKanbanItem {
  id: string;
  firstName: string | null;
  lastName: string | null;
  caseNumber: number | null;
  dependencyLevel: string | null;
  status: string | null;
  // Fase 4 — rastreabilidade / SLA (aditivo; opcional para não quebrar fixtures).
  /** ISO string of when the patient entered the current status column. */
  stageEnteredAt?: string | null;
  /** How long the patient has sat in the current status, in hours. */
  hoursInStage?: number | null;
  /** True when hoursInStage crossed the configured SLA threshold. */
  slaBreached?: boolean;
  /** The SLA threshold (hours) that applies to the current status. */
  slaThresholdHours?: number | null;
  // ── Desempate do lead sem nome (lex 30/08) ───────────────────────────────
  /**
   * E-mail de contato JÁ MASCARADO pelo servidor (`jo***@gmail.com`). Presente
   * só nas fichas cujo nome é o placeholder 'Solicitante' — nas demais é null,
   * e o endereço cru NUNCA chega ao browser (a máscara é do servidor, C1).
   */
  leadContactEmailMasked?: string | null;
  /** true quando o contato acima é do responsável, não do paciente (C6). */
  leadContactIsResponsible?: boolean;
}

/**
 * Fase 4 — funnel/traceability aggregate returned by
 * GET /api/admin/patients/funnel?country=&from=&to=.
 * The four headline stages plus the raw per-status counts.
 */
export interface PatientFunnelData {
  solicitantes: number;
  admision: number;
  agendadas: number;
  vacantes: number;
  byStatus: Record<string, number>;
}
