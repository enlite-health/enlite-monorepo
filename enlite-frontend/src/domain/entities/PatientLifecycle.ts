/**
 * Estado v2 do paciente e o Historial — spec 012, US-B7.
 * As transições permitidas são do SERVIDOR (`patient_status_transitions`, migration 315): a
 * tela só traduz a recusa (422 com `code`).
 */

/** Body de PUT /api/admin/patients/:id/status (v2) — mirrors patientStatusSchema (backend). */
export interface UpdatePatientStatusPayload {
  status: string;
  onHoldReason?: string | null;
  /** Texto clínico restrito (pacote D211.2) — nunca logado. */
  onHoldNote?: string | null;
  /** Origem da mudança → coluna "origem" do Historial. */
  changeSource?: 'admin_panel' | 'kanban';
}

/** Uma linha de GET /api/admin/patients/:id/status-history — sem ator (lex C7.2), sem nota (C7.3). */
export interface PatientStatusHistoryEntry {
  from: string | null;
  to: string;
  source: string | null;
  at: string; // ISO
}

/** Row shape used by the patient kanban board (grouped by status). */
export interface PatientKanbanItem {
  id: string;
  firstName: string | null;
  lastName: string | null;
  caseNumber: number | null;
  dependencyLevel: string | null;
  status: string | null;
  /** Funil de admissão (spec 012): SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE — a coluna do board. */
  admissionStatus: string;
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
  /** Nome do responsável primário — a identidade do card quando o paciente
   *  ainda não tem nome (D249). Texto claro; a coluna não é cifrada. */
  responsibleName: string | null;
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
