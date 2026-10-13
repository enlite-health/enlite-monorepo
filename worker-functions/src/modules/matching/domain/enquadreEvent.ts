/**
 * Regras PURAS do evento de enquadre (spec 052, Fase 2). Sem I/O: o relógio e as linhas entram por argumento.
 *
 * O servidor decide a FASE e a COLUNA; a tela só traduz (contrato `EnquadreEvent.ts` do front).
 */

export type EnquadreEventStatus = 'open' | 'closed' | 'cancelled';
export type EnquadreEventPhase = 'scheduled' | 'pending_close' | 'closed' | 'cancelled';
export type EnquadreColumnId = 'CONVOKED' | 'SELECTED' | 'QUICK_RESPONSE_TEAM' | 'REJECTED';
export type EnquadreParticipantOutcome = 'selected' | 'quick_response' | 'rejected' | 'returned';

/**
 * Fase derivada do estado guardado + relógio. Aberto antes do fim = `scheduled`; aberto no fim ou depois = `pending_close`
 * (o evento NÃO se encerra sozinho: spec §5.2 item 9). A fronteira `now == endsAt` já é `pending_close`.
 */
export function enquadreEventPhase(status: EnquadreEventStatus, endsAt: Date, now: Date): EnquadreEventPhase {
  if (status === 'closed') return 'closed';
  if (status === 'cancelled') return 'cancelled';
  return now.getTime() < endsAt.getTime() ? 'scheduled' : 'pending_close';
}

/** Coluna do kanban do evento a partir do ESTÁGIO vigente da candidatura (evento aberto). Qualquer outro estágio = Convocados. */
export function columnOfStage(stage: string | null): EnquadreColumnId {
  if (stage === 'SELECTED') return 'SELECTED';
  if (stage === 'QUICK_RESPONSE_TEAM') return 'QUICK_RESPONSE_TEAM';
  if (stage === 'REJECTED') return 'REJECTED';
  return 'CONVOKED';
}

const COLUMN_OF_OUTCOME: Readonly<Record<EnquadreParticipantOutcome, EnquadreColumnId>> = {
  selected: 'SELECTED',
  quick_response: 'QUICK_RESPONSE_TEAM',
  rejected: 'REJECTED',
  returned: 'CONVOKED',
};

export interface ParticipantColumnInput {
  eventStatus: EnquadreEventStatus;
  /** `application_funnel_stage` vigente da candidatura. */
  currentStage: string | null;
  /** Carimbo do encerramento; só existe em evento encerrado. */
  outcome: EnquadreParticipantOutcome | null;
}

/**
 * Evento ABERTO: a coluna é o estágio VIGENTE (o kanban do evento é uma vista do estágio, spec §4.1). Evento ENCERRADO: vale o
 * CARIMBO, nunca o estágio de hoje (o prestador pode ter sido movido depois; o histórico do evento não muda). Cancelado: todos
 * voltam a Convocados (não há resultado a mostrar).
 */
export function participantColumn(input: ParticipantColumnInput): EnquadreColumnId {
  if (input.eventStatus === 'closed') return input.outcome ? COLUMN_OF_OUTCOME[input.outcome] : 'CONVOKED';
  if (input.eventStatus === 'cancelled') return 'CONVOKED';
  return columnOfStage(input.currentStage);
}

export interface EnquadreOutcomeCounts {
  selected: number;
  quickResponse: number;
  rejected: number;
  returned: number;
}

export interface ColumnedParticipant {
  column: EnquadreColumnId;
  outcome: EnquadreParticipantOutcome | null;
}

/** Contadores do evento: `outcome` (do carimbo), `markedCount` (fora de Convocados) e `unmarkedCount` (em Convocados). */
export function eventCounters(participants: readonly ColumnedParticipant[]): {
  convokedCount: number;
  markedCount: number;
  unmarkedCount: number;
  outcome: EnquadreOutcomeCounts;
} {
  const outcome: EnquadreOutcomeCounts = { selected: 0, quickResponse: 0, rejected: 0, returned: 0 };
  let marked = 0;
  for (const p of participants) {
    if (p.column !== 'CONVOKED') marked += 1;
    if (p.outcome === 'selected') outcome.selected += 1;
    else if (p.outcome === 'quick_response') outcome.quickResponse += 1;
    else if (p.outcome === 'rejected') outcome.rejected += 1;
    else if (p.outcome === 'returned') outcome.returned += 1;
  }
  return {
    convokedCount: participants.length,
    markedCount: marked,
    unmarkedCount: participants.length - marked,
    outcome,
  };
}

export interface EnquadreTitleInput {
  caseNumber: number | null;
  /** Sobrenome do paciente. NUNCA o primeiro nome: esta função não tem esse parâmetro. */
  patientLastName: string | null;
  eventCode: string;
}

/**
 * `Encuadre terapéutico — Caso {nº} · {sobrenome} · ENC-XXXXXX`. Trecho ausente (nº ou sobrenome) é OMITIDO — nunca
 * "undefined" nem "null". O código é o que liga a transcrição do Tactiq ao evento (`titleHasExactCode`).
 */
export function buildEnquadreEventTitle(input: EnquadreTitleInput): string {
  const parts: string[] = [];
  if (input.caseNumber !== null && Number.isFinite(input.caseNumber)) parts.push(`Caso ${input.caseNumber}`);
  const last = input.patientLastName?.trim();
  if (last) parts.push(last);
  parts.push(input.eventCode);
  return `Encuadre terapéutico — ${parts.join(' · ')}`;
}
