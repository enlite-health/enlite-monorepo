import { reportError } from '@shared/logging';
import type { PubSubClient } from '@shared/events/PubSubClient';

/** Tópico que processa o evento de etapa (`worker_job_application_stage_events`) já gravado como `pending`. */
export const STAGE_EVENT_TOPIC = 'talentum-prescreening-qualified';

/**
 * Publica o `eventId` da mudança de estágio DEPOIS do COMMIT. O evento já está gravado (`pending`); a publicação só acelera o
 * processamento — se falhar, a varredura de segurança reprocessa. Falha é relatada (só o `source`), nunca relançada.
 * Usado pelo arrasto do funil (`WJAFunnelController.moveEncuadre`) e pelo marcar-resultado do evento de enquadre.
 */
export async function publishStageEvent(pubsub: Pick<PubSubClient, 'publish'>, eventId: string, source: string): Promise<void> {
  try {
    await pubsub.publish(STAGE_EVENT_TOPIC, { eventId });
  } catch (err) {
    reportError(err instanceof Error ? err : new Error(String(err)), { source });
  }
}
