/**
 * TalentumInboxPublisher — adapter do port `ITalentumInboxPublisher` sobre `PubSubClient`.
 * Mensagem = `{ inboxId }` e nada mais (o corpo do webhook tem PII e fica só na inbox, cifrado).
 */
import { PubSubClient } from '@shared/events/PubSubClient';
import type { ITalentumInboxPublisher } from '../domain/ITalentumInboxPublisher';

export const TALENTUM_INBOX_TOPIC = 'talentum-inbox';

export class TalentumInboxPublisher implements ITalentumInboxPublisher {
  constructor(private readonly client: Pick<PubSubClient, 'publish'> = new PubSubClient()) {}

  async publish(inboxId: string): Promise<void> {
    await this.client.publish(TALENTUM_INBOX_TOPIC, { inboxId });
  }
}
