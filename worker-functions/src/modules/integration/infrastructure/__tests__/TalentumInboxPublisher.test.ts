/**
 * TalentumInboxPublisher.test.ts — T-095-22. O PubSubClient é dublê: nada sai para o Pub/Sub real.
 */
import { TalentumInboxPublisher, TALENTUM_INBOX_TOPIC } from '../TalentumInboxPublisher';

describe('TalentumInboxPublisher', () => {
  it('publica { inboxId } no tópico talentum-inbox e SÓ isso (sem payload)', async () => {
    const client = { publish: jest.fn().mockResolvedValue('msg-1') };
    await new TalentumInboxPublisher(client).publish('inbox-123');

    expect(TALENTUM_INBOX_TOPIC).toBe('talentum-inbox');
    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, data] = client.publish.mock.calls[0];
    expect(topic).toBe('talentum-inbox');
    expect(data).toEqual({ inboxId: 'inbox-123' });
    expect(Object.keys(data)).toEqual(['inboxId']);
  });

  it('propaga a falha do publish (quem decide o que fazer é o ack)', async () => {
    const client = { publish: jest.fn().mockRejectedValue(new Error('pubsub down')) };
    await expect(new TalentumInboxPublisher(client).publish('inbox-1')).rejects.toThrow('pubsub down');
  });
});
