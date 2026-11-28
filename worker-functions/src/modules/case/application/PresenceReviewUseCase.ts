import { PresenceReviewScopeError, reviewItemKey, type DecideExceptionResult, type ExceptionDecision, type PresenceReviewGateway, type ResolutionCode, type ReviewItemEnricher, type ReviewItemFacts, type ReviewKind, type ReviewQueueEntry } from './ports/PresenceReviewPorts';

/** Países que o ator enxerga (a mesma resolução do escopo de país da request: `actorEffectiveCountries`). */
export type ActorCountries = (uid: string) => Promise<string[]>;

export interface ReviewQueueItemView extends ReviewItemFacts {
  kind: ReviewKind;
  id: string;
  occurredAt: string;
  reason: string | null;
  exceptionKind: ReviewQueueEntry['exceptionKind'];
  distanceM: number | null;
  accuracyM: number | null;
}

export interface ReviewQueueResult {
  /** O país da página devolvida. */
  country: string;
  /** Os países do ator (a tela monta o filtro com eles). */
  countries: string[];
  items: ReviewQueueItemView[];
  nextCursor: string | null;
}

/**
 * Fila de revisão de presença (emenda 077 §6). Este caso de uso só roda DEPOIS da guarda da célula `presence_exception:review` (a rota): o
 * enriquecimento (nome, nº do caso) acontece aqui e só aqui, então quem não tem a célula nunca chega a ele. O estado pendente/decidido é do attendance
 * (a tela não recalcula, critério 3 da vistoria); o país é do escopo do ator, nunca do que a tela afirma.
 */
export class PresenceReviewUseCase {
  constructor(
    private readonly gateway: PresenceReviewGateway,
    private readonly enricher: ReviewItemEnricher,
    private readonly countriesOf: ActorCountries,
  ) {}

  async queue(input: { actorUid: string; country?: string; kind?: ReviewKind; cursor?: string }): Promise<ReviewQueueResult> {
    const countries = [...(await this.countriesOf(input.actorUid))].sort();
    if (countries.length === 0) throw new PresenceReviewScopeError();
    const country = input.country ?? countries[0];
    if (!countries.includes(country)) throw new PresenceReviewScopeError();

    const page = await this.gateway.queue({ country, kind: input.kind, cursor: input.cursor });
    const facts = page.items.length > 0 ? await this.enricher.enrich(page.items) : new Map<string, ReviewItemFacts>();
    const items = page.items.map((e): ReviewQueueItemView => {
      const f = facts.get(reviewItemKey(e));
      return {
        kind: e.kind, id: e.id, occurredAt: e.occurredAt, reason: e.reason, exceptionKind: e.exceptionKind, distanceM: e.distanceM, accuracyM: e.accuracyM,
        workerName: f?.workerName ?? null, caseNumber: f?.caseNumber ?? null, startTime: f?.startTime ?? null, endTime: f?.endTime ?? null, onDate: f?.onDate ?? e.onDate,
      };
    });
    return { country, countries, items, nextCursor: page.nextCursor };
  }

  /** Os países são os efetivos do ator (os mesmos da fila): o attendance confere que o evento é de um deles, senão 404. Sem país = 403. */
  async decide(input: { actorUid: string; eventId: string; decision: ExceptionDecision; resolutionCode: ResolutionCode }): Promise<DecideExceptionResult> {
    const countries = [...(await this.countriesOf(input.actorUid))].sort();
    if (countries.length === 0) throw new PresenceReviewScopeError();
    return this.gateway.decide({ eventId: input.eventId, decision: input.decision, resolutionCode: input.resolutionCode, decidedByUid: input.actorUid, countries });
  }
}
