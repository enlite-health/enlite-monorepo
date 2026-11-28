import { Response } from 'express';

export interface TalentumWebhookContext {
  environment: 'production' | 'test';
  partnerId: string | null;
  /** `X-Forwarded-Host` ou `Host` da requisição (diz se veio pelo Hosting ou direto; spec 095 §3.3). */
  ingressHost?: string | null;
}

export interface TalentumWebhookHandler<TPayload> {
  handle(payload: TPayload, ctx: TalentumWebhookContext, res: Response): Promise<void>;
}
