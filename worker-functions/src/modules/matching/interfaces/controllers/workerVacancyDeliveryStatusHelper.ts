/**
 * workerVacancyDeliveryStatusHelper
 *
 * Module-level helper for WorkerVacancyDeliveryStatusController.getDeliveryStatus.
 * Extracted to keep the controller within the 400-line limit (mesmo padrão de
 * vacancyTalentumStatusHelper.ts).
 *
 * READ-ONLY: nunca escreve. Usado pelo painel admin e pelo E2E do funil de
 * WhatsApp pra verificar wjaStage + status de entrega sem tocar no banco direto.
 */

import type { Pool } from 'pg';

export type OutboxDeliveryStatus = {
  status: string;
  deliveryStatus: string | null;
  twilioSid: string | null;
  channel: string | null;
  templateSlug: string;
};

export type DeliveryStatusResult =
  | { kind: 'not_found' }
  | { kind: 'ok'; wjaStage: string | null; outbox: OutboxDeliveryStatus | null };

/**
 * Busca o estágio do funil (worker_job_applications.application_funnel_stage)
 * e o registro mais recente de messaging_outbox pro par (worker, vaga).
 *
 *   - WJA não existe               → { kind: 'not_found' }
 *   - WJA existe, sem outbox       → { kind: 'ok', wjaStage, outbox: null }
 *   - WJA existe, outbox existe    → { kind: 'ok', wjaStage, outbox: {...} } (mais recente por created_at)
 */
export async function getWorkerVacancyDeliveryStatus(
  db: Pool,
  workerId: string,
  vacancyId: string,
): Promise<DeliveryStatusResult> {
  const wjaResult = await db.query<{ application_funnel_stage: string | null }>(
    `SELECT application_funnel_stage
     FROM worker_job_applications
     WHERE worker_id = $1 AND job_posting_id = $2`,
    [workerId, vacancyId],
  );

  if (wjaResult.rows.length === 0) {
    return { kind: 'not_found' };
  }

  const wjaStage = wjaResult.rows[0].application_funnel_stage;

  const outboxResult = await db.query<{
    status: string;
    delivery_status: string | null;
    twilio_sid: string | null;
    channel: string | null;
    template_slug: string;
  }>(
    `SELECT status, delivery_status, twilio_sid, channel, template_slug
     FROM messaging_outbox
     WHERE worker_id = $1 AND job_posting_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [workerId, vacancyId],
  );

  if (outboxResult.rows.length === 0) {
    return { kind: 'ok', wjaStage, outbox: null };
  }

  const row = outboxResult.rows[0];
  return {
    kind: 'ok',
    wjaStage,
    outbox: {
      status: row.status,
      deliveryStatus: row.delivery_status,
      twilioSid: row.twilio_sid,
      channel: row.channel,
      templateSlug: row.template_slug,
    },
  };
}
