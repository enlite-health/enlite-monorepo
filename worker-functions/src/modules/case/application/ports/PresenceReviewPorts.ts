/**
 * Portas da fila de revisão de presença da coordenação (emenda 077 §6). O attendance é o dono do estado (`presence_exception_state`):
 * a fila e a decisão passam por ele, e o WF só ENRIQUECE a leitura (nome do prestador, nº do caso) — para quem tem a célula
 * `presence_exception:review`. Nenhum tipo desta porta carrega endereço, coordenada, texto clínico nem texto livre.
 */
export const REVIEW_KINDS = ['EXCEPTION_PENDING', 'EXIT_DECLARED', 'CLOCK_UNVERIFIED', 'ENTRY_REFUSED_NO_ENTRY'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const DECISIONS = ['APPROVED', 'REFUSED'] as const;
export type ExceptionDecision = (typeof DECISIONS)[number];

/** Lista fechada de 5 (§3.5): o painel mostra o texto, o attendance grava o código. */
export const RESOLUTION_CODES = ['INDOOR_CONFIRMED', 'ADDRESS_TO_FIX', 'PATIENT_ELSEWHERE_CONFIRMED', 'NOT_AT_PATIENT', 'NO_EVIDENCE'] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

/** Um item da fila como o attendance o entrega: só ids, motivo, instantes e distância/precisão em metros inteiros. */
export interface ReviewQueueEntry {
  kind: ReviewKind;
  /** `event_id` (EXCEPTION_PENDING, CLOCK_UNVERIFIED), `declaration_id` (EXIT_DECLARED) ou `occurrence_id` (ENTRY_REFUSED_NO_ENTRY). */
  id: string;
  occurrenceId: string;
  workerId: string;
  slotId: string | null;
  onDate: string | null;
  occurredAt: string;
  reason: string | null;
  exceptionKind: 'GEO_DECLARED' | 'GEO_SERVER_DISAGREES' | null;
  distanceM: number | null;
  accuracyM: number | null;
}

export interface ReviewQueuePageResult {
  items: ReviewQueueEntry[];
  nextCursor: string | null;
}

export interface DecideExceptionInput {
  eventId: string;
  decision: ExceptionDecision;
  resolutionCode: ResolutionCode;
  decidedByUid: string;
}

export interface DecideExceptionResult {
  eventId: string;
  decision: ExceptionDecision;
  resolutionCode: string;
}

/** Dono: o attendance. Falha de rede/contrato lança `PresenceUnavailableError`; resposta 4xx do attendance, `PresenceReviewUpstreamError`. */
export interface PresenceReviewGateway {
  queue(query: { country: string; kind?: ReviewKind; cursor?: string }): Promise<ReviewQueuePageResult>;
  decide(input: DecideExceptionInput): Promise<DecideExceptionResult>;
}

/** 400 / 404 / 409 do attendance, repassados como estão (o 409 `EXCEPTION_ALREADY_DECIDED` chega à tela). `code` é de conjunto fechado, nunca corpo cru. */
export class PresenceReviewUpstreamError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string) {
    super(`presence_review_upstream:${status}:${code}`);
    this.name = 'PresenceReviewUpstreamError';
  }
}

/** O que o WF resolve SÓ na leitura, para quem tem a célula. Qualquer campo pode faltar (turno que saiu do itinerário). */
export interface ReviewItemFacts {
  workerName: string | null;
  caseNumber: number | null;
  startTime: string | null;
  endTime: string | null;
  onDate: string | null;
}

export const reviewItemKey = (e: Pick<ReviewQueueEntry, 'kind' | 'id'>): string => `${e.kind}:${e.id}`;

export interface ReviewItemEnricher {
  enrich(items: ReadonlyArray<ReviewQueueEntry>): Promise<Map<string, ReviewItemFacts>>;
}

/** O ator não tem país concedido, ou pediu um país fora do escopo dele. */
export class PresenceReviewScopeError extends Error {
  constructor() {
    super('presence_review_scope');
    this.name = 'PresenceReviewScopeError';
  }
}
