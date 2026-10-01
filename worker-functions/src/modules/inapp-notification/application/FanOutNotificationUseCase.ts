/**
 * FanOutNotificationUseCase — fan-out de notificações in-app (spec 022, Bloco 4, T402).
 * Implementa `PostMessageFanOutHook` (`@modules/conversation`) — `PostMessageUseCase` (T403)
 * substitui o stub `NoopFanOutHook` por este adaptador, chamado dentro da MESMA transação do
 * POST message (D-09).
 *
 * Algoritmo (D-09, `contracts/openapi-notifications.md`):
 *   1. `mentioned` = `message.mentionedUids` menos o autor da mensagem atual.
 *   2. `threadParticipants` = autores da thread (ROOT + todas as replies, via
 *      `ConversationRepository.listThreadAuthorUids`) menos o autor atual E menos quem já está
 *      em `mentioned` — SÓ consultado quando a mensagem É uma reply (`rootMessageId` presente);
 *      mensagem de topo nunca gera `CONVERSATION_REPLIED` (ninguém respondeu a nada ainda).
 *   3. Um `notification_events` por TIPO com destinatário não-vazio — nunca um evento vazio.
 *
 * Decisão de desenho (registrada aqui e na evidência, D-09 não desambigua isto): um uid que é
 * AO MESMO TEMPO mencionado e participante da thread recebe SÓ `CONVERSATION_MENTIONED` — a
 * menção é o sinal mais específico ("te chamaram", não só "você está na conversa"); evita 2
 * notificações para a MESMA mensagem.
 */
import type { PoolClient } from 'pg';
import type { PostMessageFanOutHook, PostMessageResult } from '@modules/conversation/application/PostMessageUseCase';
import { ConversationRepository } from '@modules/conversation/infrastructure/ConversationRepository';
import { NotificationRepository, type NotificationTypeCode } from '../infrastructure/NotificationRepository';

export class FanOutNotificationUseCase implements PostMessageFanOutHook {
  constructor(
    private readonly notificationRepository: NotificationRepository = new NotificationRepository(),
    private readonly conversationRepository: ConversationRepository = new ConversationRepository(),
  ) {}

  async execute(client: PoolClient, message: PostMessageResult): Promise<void> {
    const mentioned = new Set(message.mentionedUids.filter((uid) => uid !== message.authorUid));

    const threadParticipants = new Set<string>();
    if (message.rootMessageId) {
      const authorUids = await this.conversationRepository.listThreadAuthorUids(message.rootMessageId, client);
      for (const uid of authorUids) {
        if (uid !== message.authorUid && !mentioned.has(uid)) threadParticipants.add(uid);
      }
    }

    if (mentioned.size > 0) {
      await this.createEvent(client, 'CONVERSATION_MENTIONED', message, [...mentioned]);
    }
    if (threadParticipants.size > 0) {
      await this.createEvent(client, 'CONVERSATION_REPLIED', message, [...threadParticipants]);
    }
  }

  private async createEvent(
    client: PoolClient,
    typeCode: NotificationTypeCode,
    message: PostMessageResult,
    recipientUids: string[],
  ): Promise<void> {
    const eventId = await this.notificationRepository.insertEvent(
      {
        typeCode,
        actorUid: message.authorUid,
        patientId: message.patientId,
        conversationId: message.conversationId,
        messageId: message.id,
      },
      client,
    );
    await this.notificationRepository.insertNotifications(eventId, recipientUids, client);
  }
}
