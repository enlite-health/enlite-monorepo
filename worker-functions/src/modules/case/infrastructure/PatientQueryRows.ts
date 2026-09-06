/**
 * PatientQueryRows — o READ MODEL da ficha e da listagem de paciente.
 *
 * Extraído de `PatientQueryRepository` para manter aquele arquivo dentro do teto de 400 linhas
 * (mesmo molde de `PatientRelatedWriter`). São só tipos: nenhuma linha de execução mudou.
 *
 * Ganho de desenho junto: `PatientDetailQueryHelper` importava estes tipos DO repositório, que
 * por sua vez importa `fetchPatientDetail` do helper — um ciclo. Com o shape morando sozinho,
 * os dois passam a depender do contrato, não um do outro.
 *
 * O repositório continua sendo a porta pública: ele re-exporta tudo daqui (`export type`, que
 * o TypeScript apaga na compilação), então nenhum chamador precisou mudar de import.
 */

// ── Detail types ──────────────────────────────────────────────────────────────

export interface PatientResponsibleDetail {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string | null;
  /** Decrypted phone or null if absent/encrypted. */
  phone: string | null;
  /** Decrypted email or null if absent/encrypted. */
  email: string | null;
  /** Decrypted document number or null. */
  documentNumber: string | null;
  documentType: string | null;
  isPrimary: boolean;
  displayOrder: number;
  source: string;
}

export interface PatientAddressDetail {
  id: string;
  addressType: string;
  addressFormatted: string | null;
  addressRaw: string | null;
  /** Address complement (Depto, Piso, andar). Manual UI entry. Migration 157. */
  complement: string | null;
  displayOrder: number;
  /** Latitude geocodificada. Migrated from job_postings.service_lat (migration 153/154). */
  lat: number | null;
  /** Longitude geocodificada. Migrated from job_postings.service_lng (migration 153/154). */
  lng: number | null;
  /** True when address_type === 'primary'. */
  isPrimary: boolean;
  /** Zona/bairro (coluna `neighborhood`, mig 147 — spec 012 lex C2.7: não duplicar). */
  neighborhood: string | null;
  /** Corredor logístico por endereço (mig 316). */
  logisticsCorridor: string | null;
  /** Logística e acesso — texto livre sobre o domicílio (mig 316; lex C2: fora do mcp_ro, nunca em log). */
  accessNotes: string | null;
  /** Jurisdição do endereço (mig 316). */
  country: string | null;
  /** Computed availability for this address based on active vacancies. */
  availability: import('../application/AddressAvailabilityCalculator').AddressAvailability;
}

export interface PatientProfessionalDetail {
  id: string;
  name: string;
  /** Decrypted phone or null. */
  phone: string | null;
  /** Decrypted email or null. */
  email: string | null;
  displayOrder: number;
  isTeam: boolean;
}

export interface PatientDetailRow {
  // Identity
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null;
  phoneWhatsapp: string | null;
  /** E-mail do paciente, descriptografado (KMS) SÓ no detalhe — spec 011 A4. null = não informado. */
  contactEmail: string | null;
  // Clinical
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  clinicalSegments: string | null;
  serviceType: string[] | null;
  deviceType: string | null;
  additionalComments: string | null;
  /** Autoria da última edição das observações (mig 286): ISO/Date e NOME resolvido de users. */
  additionalCommentsUpdatedAt: Date | null;
  additionalCommentsUpdatedBy: string | null;
  /** Instruções de emergência (mig 294): valor + autoria; redigido no ponto único quando o ator não pode ler. */
  emergencyInstructions: string | null;
  emergencyInstructionsUpdatedAt: Date | null;
  emergencyInstructionsUpdatedBy: string | null;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
  // Coverage
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  // Location
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  // Grupos de WhatsApp do Periskope por PAPEL (migration 261) — chave de join
  // com a auditoria de informes (Candela). Sempre @g.us. Papel ausente do mapa
  // = não vinculado.
  chatIds: Record<string, string>;
  /** @deprecated alias de `chatIds.FAMILY`; sai com a migration de contract. */
  familyChatId: string | null;
  /** @deprecated alias de `chatIds.PROVIDERS`; sai com a migration de contract. */
  providersChatId: string | null;
  // Status / flags
  status: string | null;
  /** Funil de admissão (mig 313): SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE. */
  admissionStatus: string;
  /** Motivo da espera quando status = ON_HOLD (mig 314). */
  onHoldReason: string | null;
  /** Texto clínico RESTRITO (mig 314, pacote D211.2) — redigido no ponto único quando o ator não pode ler. */
  onHoldNote: string | null;
  /** Data de início do serviço (mig 317). */
  serviceStartDate: Date | null;
  /** Coberturas verificadas por CÓDIGO (mig 312), ordem do catálogo. */
  insuranceVerifiedCodes: string[];
  /**
   * As mesmas coberturas, COM origem (spec 012, QA 🟡3/SUP-B5) — o drawer usa `source` para
   * distinguir o que veio do ClickUp (chip travado) do que o painel gravou (editável no
   * multi-select). `insuranceVerifiedCodes` continua existindo, sem origem, para compat.
   */
  insuranceVerifiedEntries: Array<{ code: string; source: string }>;
  /** Dispositivos (códigos de device_types, mig 307), ordem do catálogo. */
  deviceTypes: string[];
  needsAttention: boolean;
  attentionReasons: string[];
  /** Spec 014 (US-D3, lex D3.1): `phoneWhatsapp` coincide (últimos 8 dígitos) com o telefone de
   * algum responsável — SÓ no detalhe, nunca na lista/kanban. */
  phoneMatchesResponsible: boolean;
  // Related
  responsibles: PatientResponsibleDetail[];
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  /**
   * Serviços contratados (spec 013, bloco C — migration 319), com prestadores alocados. Contrato
   * do detalhe. `hourlyValue` é redigido no ponto único (AdminPatientsController.getPatientById,
   * lex C-c.4) para quem não é admin — aqui vem sempre o valor cru.
   */
  contractedServices: import('./PatientContractedServiceRepository').ContractedServiceDetail[];
  /** Last case_number across all job_postings for this patient (null if none). */
  lastCaseNumber: number | null;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}

export interface PatientListRow {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  serviceType: string[] | null;
  documentType: string | null;
  documentNumber: string | null;
  sex: string | null;
  /** Patient lifecycle status (kanban column). Null for rows whose ClickUp status is unrecognised. */
  status: string | null;
  /** Funil de admissão (mig 313) — é ESTA a coluna do Kanban de pacientes (spec 012). */
  admissionStatus: string;
  needsAttention: boolean;
  attentionReasons: string[];
  /** Registro sintético do synthetic monitoring — alvo do sweeper (migration 257). */
  isTest: boolean;
  /** Number of addresses linked to this patient. */
  addressesCount: number;
  /**
   * Effective case number: patients.case_number when set (newer records), or
   * MAX(job_postings.case_number) for legacy patients that only have vagas.
   * Null when neither is present.
   */
  caseNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
  // ── SLA de inatividade (Fase 4, aditivo) ─────────────────────────────────
  /** Instante em que o paciente entrou no status atual (ISO), ou null. */
  stageEnteredAt: string | null;
  /** Horas inteiras no estágio atual, ou null se sem âncora. */
  hoursInStage: number | null;
  /** Teto de horas do estágio, ou null quando o estágio não tem SLA. */
  slaThresholdHours: number | null;
  /** true quando há teto e hoursInStage o ultrapassa. */
  slaBreached: boolean;
  // ── Desempate do lead sem nome (lex 30/08, C1/C2/C6) ─────────────────────
  /**
   * E-mail de contato JÁ MASCARADO (`jo***@gmail.com`), presente APENAS nas
   * fichas cujo nome é o placeholder 'Solicitante'. Ficha com nome real devolve
   * null e nem chega a ser descriptografada — o corte é aqui, no servidor, para
   * que o payload não carregue contato do board inteiro (C2).
   */
  /** Nome do responsável primário, texto claro (a coluna não é cifrada).
   *  `null` quando não há responsável — o lead "para mí" não tem. */
  responsibleName: string | null;
    leadContactEmailMasked: string | null;
  /**
   * true quando o e-mail acima é do RESPONSÁVEL, não do paciente — acontece nos
   * leads em que quem preencheu o formulário foi o familiar. Sem esta marca o
   * card mostraria contato de um terceiro sob o nome de um paciente (C6).
   */
  leadContactIsResponsible: boolean;
}

export interface PatientStatsRow {
  total: number;
  complete: number;
  needsAttention: number;
  createdToday: number;
  createdYesterday: number;
  createdLast7Days: number;
}
