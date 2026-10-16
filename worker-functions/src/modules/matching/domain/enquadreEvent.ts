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
  /**
   * NUNCA nome nem sobrenome do paciente: esta função não tem esses parâmetros. O evento é visível aos prestadores
   * convidados, que ainda não atuam no caso — dado pessoal do paciente não pode chegar a eles (Gabriel, 16/10/2026).
   */
  eventCode: string;
}

/**
 * `Encuadre terapéutico — Caso {nº} · ENC-XXXXXX`. Nº do caso ausente é OMITIDO — nunca "undefined" nem "null".
 * O código é o que liga a transcrição do Tactiq ao evento (`titleHasExactCode`).
 */
export function buildEnquadreEventTitle(input: EnquadreTitleInput): string {
  const parts: string[] = [];
  if (input.caseNumber !== null && Number.isFinite(input.caseNumber)) parts.push(`Caso ${input.caseNumber}`);
  parts.push(input.eventCode);
  return `Encuadre terapéutico — ${parts.join(' · ')}`;
}

/** Estágio vigente da candidatura → carimbo da participação no encerramento. Estágio que não é de resultado = `returned` (devolvido). */
export function outcomeOfStage(stage: string | null): EnquadreParticipantOutcome {
  if (stage === 'SELECTED') return 'selected';
  if (stage === 'QUICK_RESPONSE_TEAM') return 'quick_response';
  if (stage === 'REJECTED') return 'rejected';
  return 'returned';
}

/** Coluna do kanban do evento → estágio da candidatura (o MESMO estágio do Recrutamento, spec §4.1). Voltar a Convocados = `COMPLETED`. */
export const STAGE_OF_COLUMN: Readonly<Record<EnquadreColumnId, string>> = {
  CONVOKED: 'COMPLETED',
  SELECTED: 'SELECTED',
  QUICK_RESPONSE_TEAM: 'QUICK_RESPONSE_TEAM',
  REJECTED: 'REJECTED',
};

/** Textos FIXOS das anotações automáticas (spec 052 §5.1 item 5 e §5.2 item 8). `wallClock` = `dd/mm hh:mm` no fuso do país do evento. */
export const cancelledNoteText = (wallClock: string): string => `El encuadre del ${wallClock} fue cancelado`;
export const notMarkedNoteText = (wallClock: string): string => `No fue marcado en el encuadre del ${wallClock}`;
