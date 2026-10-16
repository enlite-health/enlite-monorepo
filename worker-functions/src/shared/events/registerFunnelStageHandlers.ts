import type { Pool } from 'pg';
import type { DomainEventProcessor } from './DomainEventProcessor';
import type { PubSubClient } from './PubSubClient';
import type { TokenService } from '../../modules/notification/infrastructure/TokenService';
import { createStageMessageHandler } from './handlers/StageMessageHandler';
import { FUNNEL_STAGES, funnelStageEventName } from '../../modules/matching/application/FunnelStageEventEmitter';

/**
 * Registra UM `StageMessageHandler` por etapa do funil (`funnel_stage.<etapa>`), QUALIFIED inclusive.
 *
 * Spec 052 (T-40b): o convite automático ao qualificar saiu; QUALIFIED não tem mais handler próprio.
 * Evento sem handler vira `failed` no `DomainEventProcessor`, por isso a etapa continua com dono.
 * Extraído do `index.ts` para o teste com banco (`qualified-no-invite-052.e2e.test.ts`) exercitar o
 * MESMO registro que o servidor usa.
 */
export function registerFunnelStageHandlers(
  processor: DomainEventProcessor,
  db: Pool,
  pubsub: PubSubClient,
  tokenService: TokenService,
): void {
  for (const stage of FUNNEL_STAGES) {
    processor.registerHandler(funnelStageEventName(stage), createStageMessageHandler(db, pubsub, tokenService, stage));
  }
}
