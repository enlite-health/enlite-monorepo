import { Request, Response } from 'express';
import { PeriskopeNoteService } from '../../infrastructure/PeriskopeNoteService';
import { logger } from '@shared/logging';

/**
 * ChatwootMirrorController — recebe o webhook `message_created` do Chatwoot e
 * espelha CADA mensagem da conversa da Luz como NOTA interna no Periskope, pra o
 * time de recrutamento ver o que a Luz (e o worker) falam, e poder assumir.
 *
 * Cobre os DOIS lados num hook só: o Chatwoot dispara message_created tanto pro
 * `incoming` (resposta do worker, que o InboundWhatsAppController já espelhou pro
 * Chatwoot) quanto pro `outgoing` (resposta da Luz). O bot NUNCA envia pelo
 * Periskope — nota é interna (não vai pro WhatsApp), então respeita a trava do ban.
 *
 * Best-effort: sempre responde 200 (o Chatwoot não deve retentar). Gated por
 * PERISKOPE_NOTE_MIRROR_ENABLED — deploy neutro até o go-live.
 */
export class ChatwootMirrorController {
  constructor(private readonly noteService: PeriskopeNoteService) {}

  async handle(req: Request, res: Response): Promise<void> {
    // Token compartilhado (Chatwoot manda no header ou query). Sem token
    // configurado, pula a checagem (dev/test).
    const expected = process.env.CHATWOOT_MIRROR_WEBHOOK_TOKEN;
    if (expected) {
      const got = (req.headers['x-mirror-token'] as string) || (req.query.token as string) || '';
      if (got !== expected) {
        res.status(403).end();
        return;
      }
    }

    if (process.env.PERISKOPE_NOTE_MIRROR_ENABLED !== 'true') {
      res.status(200).end();
      return;
    }

    try {
      const body = req.body as Record<string, any>;
      if (body?.event !== 'message_created') {
        res.status(200).end();
        return;
      }
      const messageType = body.message_type; // 'incoming' | 'outgoing' | 'activity'
      const isPrivate = body.private === true;
      const content: string = (body.content ?? '').toString().trim();

      if (isPrivate || !content || (messageType !== 'incoming' && messageType !== 'outgoing')) {
        res.status(200).end();
        return;
      }

      const phone: string | undefined =
        body.conversation?.meta?.sender?.phone_number ??
        body.sender?.phone_number ??
        body.conversation?.contact_inbox?.source_id?.replace?.('whatsapp:', '');

      if (!phone) {
        res.status(200).end();
        return;
      }

      // 🤖 marca a fala da Luz; o worker entra sem prefixo (é ele falando).
      const note = messageType === 'outgoing' ? `🤖 Luz: ${content}` : content;
      await this.noteService.mirrorAsNote(phone, note);
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, '[ChatwootMirror] erro (best-effort)');
    }

    res.status(200).end();
  }
}
