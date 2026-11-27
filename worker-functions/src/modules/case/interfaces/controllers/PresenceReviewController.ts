import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AuthMiddleware } from '@modules/identity';
import { actorEffectiveCountries } from '@modules/identity/application/resolveCountryScope';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError, toSafeError } from '@shared/logging';
import { PresenceReviewUseCase } from '../../application/PresenceReviewUseCase';
import { PresenceUnavailableError } from '../../application/ports/PresenceReaderPort';
import { PresenceReviewScopeError, PresenceReviewUpstreamError } from '../../application/ports/PresenceReviewPorts';
import { HttpAttendancePresenceReviewGateway } from '../../infrastructure/HttpAttendancePresenceReviewGateway';
import { ItineraryShiftDirectory } from '../../infrastructure/ItineraryShiftDirectory';
import { PgPresenceReviewEnricher } from '../../infrastructure/PgPresenceReviewEnricher';
import { presenceDecisionBodySchema, presenceDecisionParamsSchema, presenceReviewQuerySchema } from '../validators/presenceReviewSchemas';

/** Composição real (adapters de produção). Só aqui os adapters encontram o caso de uso; o pool só abre na 1ª chamada. */
export function buildPresenceReviewUseCase(pool?: Pool): PresenceReviewUseCase {
  const lazyPool = (): Pool => pool ?? DatabaseConnection.getInstance().getPool();
  return new PresenceReviewUseCase(
    new HttpAttendancePresenceReviewGateway(),
    new PgPresenceReviewEnricher(new ItineraryShiftDirectory(pool), pool),
    (uid) => actorEffectiveCountries(lazyPool(), uid),
  );
}

/**
 * Fila de revisão de presença da coordenação (emenda 077 §6) — o controller só valida forma, despacha e mapeia erro → HTTP. A guarda da célula
 * `presence_exception:review` é da ROTA (declarada no array, vista pelo scanner do catálogo); aqui chegam só os que a têm. Log SÓ de códigos e
 * contagens: nome do prestador, nº do caso, uid e id de evento nunca entram em log.
 */
export class PresenceReviewController {
  private useCaseMemo?: PresenceReviewUseCase;

  /** Sem `useCase` a composição real é montada na 1ª chamada (nunca no import do `index.ts`). */
  constructor(useCase?: PresenceReviewUseCase) {
    this.useCaseMemo = useCase;
  }

  private get useCase(): PresenceReviewUseCase {
    return (this.useCaseMemo ??= buildPresenceReviewUseCase());
  }

  /** GET /api/admin/presence/review-queue?country=&kind=&cursor= */
  async queue(req: Request, res: Response): Promise<void> {
    const query = presenceReviewQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, code: 'INVALID_QUERY' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    try {
      const result = await this.useCase.queue({ actorUid, ...query.data });
      logger.info({ msg: '[presence/review] queue', kind: query.data.kind ?? 'ALL', count: result.items.length, hasNext: result.nextCursor !== null });
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'queue');
    }
  }

  /** POST /api/admin/presence/exceptions/:eventId/decision `{ decision, resolution_code }` */
  async decide(req: Request, res: Response): Promise<void> {
    const params = presenceDecisionParamsSchema.safeParse(req.params);
    const body = presenceDecisionBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ success: false, code: 'INVALID_DECISION' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    try {
      const result = await this.useCase.decide({ actorUid, eventId: params.data.eventId, decision: body.data.decision, resolutionCode: body.data.resolution_code });
      logger.info({ msg: '[presence/review] decided', decision: result.decision, resolutionCode: result.resolutionCode });
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'decide');
    }
  }

  private requireActor(req: Request, res: Response): string | null {
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return null;
    }
    return actorUid;
  }

  private handleError(err: unknown, res: Response, method: string): void {
    if (err instanceof PresenceReviewScopeError) {
      res.status(403).json({ success: false, code: 'COUNTRY_SCOPE_REQUIRED' });
      return;
    }
    if (err instanceof PresenceReviewUpstreamError) {
      res.status(err.status).json({ success: false, code: err.code });
      return;
    }
    if (err instanceof PresenceUnavailableError) {
      logger.warn({ msg: '[presence/review] attendance indisponivel', method, reason: err.reason });
      res.status(503).json({ success: false, code: 'UPSTREAM_UNAVAILABLE' });
      return;
    }
    reportError(toSafeError(err), { source: `PresenceReviewController:${method}` });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
