import { Request, Response } from 'express';
import { PartnerContext } from '../../../domain/WebhookPartner';
import { ITalentumInboxRepository } from '../../../domain/TalentumInbox';
import { ITalentumInboxPublisher } from '../../../domain/ITalentumInboxPublisher';
import { TalentumInboxRepository } from '../../../infrastructure/TalentumInboxRepository';
import { TalentumInboxPublisher } from '../../../infrastructure/TalentumInboxPublisher';
import { PrescreeningResponseHandler } from '../handlers/PrescreeningResponseHandler';
import { TalentumWebhookContext } from '../handlers/TalentumWebhookHandler';

/** Primeiro valor de um header (pode vir repetido), cortado em 255 caracteres. */
function headerValue(v: string | string[] | undefined): string | null {
  const first = Array.isArray(v) ? v[0] : v;
  return first ? first.split(',')[0].trim().slice(0, 255) || null : null;
}

/**
 * Webhook do Talentum (`/api/webhooks` e `/api/webhooks-test`): só ACK (spec 095 §3.2). Guarda na inbox,
 * publica o id e responde 200; o processamento (Zod completo + caso de uso) é do processador.
 * Nenhum log carrega o corpo (PII): o ack loga só ids, enums e booleanos.
 */
export class TalentumWebhookController {
  private readonly ackHandler: PrescreeningResponseHandler;

  constructor(
    inbox: ITalentumInboxRepository = new TalentumInboxRepository(),
    publisher: ITalentumInboxPublisher = new TalentumInboxPublisher(),
  ) {
    this.ackHandler = new PrescreeningResponseHandler(inbox, publisher);
  }

  async handlePrescreening(req: Request, res: Response): Promise<void> {
    const partnerContext = (req as any).partnerContext as PartnerContext | undefined;
    const ctx: TalentumWebhookContext = {
      environment: partnerContext?.isTest ? 'test' : 'production',
      partnerId: partnerContext?.partnerId ?? null,
      ingressHost: headerValue(req.headers?.['x-forwarded-host']) ?? headerValue(req.headers?.host),
    };
    return this.ackHandler.handle(req.body, ctx, res);
  }
}
