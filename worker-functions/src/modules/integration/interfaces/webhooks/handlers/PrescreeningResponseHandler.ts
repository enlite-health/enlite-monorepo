import { Response } from 'express';
import { TalentumWebhookHandler, TalentumWebhookContext } from './TalentumWebhookHandler';
import { computeBodyHash, ITalentumInboxRepository } from '../../../domain/TalentumInbox';
import { ITalentumInboxPublisher } from '../../../domain/ITalentumInboxPublisher';
import { reportError, toSafeError } from '@shared/logging';

const TAG = '[TalentumWebhook:Ack]';

/** O que o ack extrai do corpo: só ids e enums. O corpo inteiro (PII) vai cifrado para a inbox e nunca ao log. */
export interface TalentumAckFields {
  action: string;
  subtype: string | null;
  statusLabel: string | null;
  prescreeningId: string | null;
  profileId: string | null;
}

const nonEmptyString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/**
 * Validação MÍNIMA do ack (spec 095 §3.2): `action` string; PRESCREENING_RESPONSE → `data.prescreening.id` e
 * `data.profile.id`; PRESCREENING → `data._id`. O Zod completo roda no processador, depois do 200.
 * Devolve `null` quando o corpo não passa (o chamador responde 400).
 */
export function parseAck(body: unknown): TalentumAckFields | null {
  const b = body as Record<string, any> | null | undefined;
  const action = b?.action;
  if (typeof action !== 'string' || action.length === 0) return null;

  const subtype = typeof b?.subtype === 'string' ? b.subtype : null;
  if (action === 'PRESCREENING_RESPONSE') {
    const prescreeningId = nonEmptyString(b?.data?.prescreening?.id);
    const profileId = nonEmptyString(b?.data?.profile?.id);
    if (!prescreeningId || !profileId) return null;
    const statusLabel = typeof b?.data?.response?.statusLabel === 'string' ? b.data.response.statusLabel : null;
    return { action, subtype, statusLabel, prescreeningId, profileId };
  }
  if (action === 'PRESCREENING') {
    const prescreeningId = nonEmptyString(b?.data?._id);
    if (!prescreeningId) return null;
    return { action, subtype, statusLabel: null, prescreeningId, profileId: null };
  }
  // action desconhecida: guarda mesmo assim (o processador a marca UNSUPPORTED; evento nunca se perde em silêncio)
  return { action, subtype, statusLabel: null, prescreeningId: null, profileId: null };
}

/**
 * Ack rápido do webhook (spec 095 §3.2): guarda o corpo cifrado na inbox, publica só o `inboxId` e responde 200.
 * NÃO executa o caso de uso: o processamento é do processador (Pub/Sub push), depois do ack.
 *  - INSERT falhou → 503 `{ error: 'retry' }` (única resposta que o Talentum pode reenviar) + reportError sem PII;
 *  - publish falhou → 200 mesmo assim + reportError (a linha fica RECEIVED e o alarme `inbox_pendente` cobre);
 *  - duplicado (mesmo corpo) → 200.
 */
export class PrescreeningResponseHandler implements TalentumWebhookHandler<unknown> {
  constructor(
    private readonly inbox: ITalentumInboxRepository,
    private readonly publisher: ITalentumInboxPublisher,
  ) {}

  async handle(body: unknown, ctx: TalentumWebhookContext, res: Response): Promise<void> {
    const ack = parseAck(body);
    if (!ack) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    let inboxId: string;
    let duplicate: boolean;
    try {
      ({ id: inboxId, duplicate } = await this.inbox.insertReceived({
        bodyHash: computeBodyHash(body),
        action: ack.action,
        subtype: ack.subtype,
        statusLabel: ack.statusLabel,
        prescreeningId: ack.prescreeningId,
        profileId: ack.profileId,
        environment: ctx.environment,
        ingressHost: ctx.ingressHost ?? null,
        payload: body,
      }));
    } catch (err) {
      // Erro sem PII (toSafeError: do pg só code/constraint). 503, nunca 500: é o que o Talentum pode reenviar.
      reportError(toSafeError(err), { source: 'PrescreeningResponseHandler:ack-insert', talentumPrescreeningId: ack.prescreeningId });
      res.status(503).json({ error: 'retry' });
      return;
    }

    try {
      await this.publisher.publish(inboxId);
    } catch (err) {
      reportError(toSafeError(err), { source: 'PrescreeningResponseHandler:ack-publish', inboxId });
    }

    console.log(
      `${TAG} inboxId=${inboxId} | subtype=${ack.subtype ?? 'none'} | ingress_host=${ctx.ingressHost ?? 'none'} | duplicate=${duplicate}`,
    );
    res.status(200).json({ received: true });
  }
}
