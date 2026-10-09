/**
 * TwilioWebhookController.admission.test.ts — spec 049 M5: o status da Twilio volta para `admission_messages` pelo SID e
 * entra na trilha. O armazém e a trilha são dublês em memória (a prova com Postgres real e HTTP é o e2e de mensageria).
 */
const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { Request, Response } from 'express';
import { InMemoryAdmissionStore } from '@modules/matching/infrastructure/doubles/InMemoryAdmissionStore';
import { TwilioWebhookController } from '../TwilioWebhookController';

const res = () => ({ status: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() }) as unknown as Response;
const req = (body: Record<string, string>) => ({ body, headers: {} }) as unknown as Request;

async function seeded(status: 'sent' | 'send_failed' = 'sent') {
  const store = new InMemoryAdmissionStore();
  const id = await store.claim({ appointmentId: 'a1', kind: 'confirmation', attempt: 0 });
  await store.setStatus(id as string, status, 'SM1');
  const rid = await store.claim({ appointmentId: 'a1', kind: 'reminder_30min', attempt: 0 });
  await store.setStatus(rid as string, 'sent', 'SM2');
  return { store, controller: new TwilioWebhookController(store, store) };
}

describe('TwilioWebhookController — mensagens de admissão', () => {
  beforeEach(() => {
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    mockQuery.mockClear();
  });

  it('delivered → status da linha + evento confirmation_delivered (só ids na ref)', async () => {
    const { store, controller } = await seeded();
    const r = res();
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'delivered' }), r);
    expect(store.messages[0].status).toBe('delivered');
    expect(store.events).toEqual([
      expect.objectContaining({ appointmentId: 'a1', kind: 'confirmation_delivered', outcome: 'delivered', ref: { twilioSid: 'SM1', kind: 'confirmation', attempt: 0, errorCode: null } }),
    ]);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('o lembrete usa o prefixo reminder_; failed/undelivered viram *_failed com o código de erro', async () => {
    const { store, controller } = await seeded();
    await controller.handleStatusCallback(req({ MessageSid: 'SM2', MessageStatus: 'undelivered', ErrorCode: '63024' }), res());
    expect(store.messages[1].status).toBe('undelivered');
    expect(store.events[0]).toMatchObject({ kind: 'reminder_failed', reason: 'twilio_undelivered', ref: { errorCode: '63024' } });
  });

  it('callback fora de ordem não regride: entregue não volta a failed nem a sent, e não duplica evento', async () => {
    const { store, controller } = await seeded();
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'delivered' }), res());
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'failed' }), res());
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'delivered' }), res());
    expect(store.messages[0].status).toBe('delivered');
    expect(store.events).toHaveLength(1);
  });

  it('status intermediário (queued/sending) e SID desconhecido não escrevem nada', async () => {
    const { store, controller } = await seeded();
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'queued' }), res());
    await controller.handleStatusCallback(req({ MessageSid: 'SM-DE-WORKER', MessageStatus: 'delivered' }), res());
    expect(store.events).toHaveLength(0);
  });

  it('erro no armazém é engolido: a Twilio sempre recebe 200', async () => {
    const { store, controller } = await seeded();
    store.applyDeliveryStatus = async () => {
      throw new Error('db fora');
    };
    const r = res();
    await controller.handleStatusCallback(req({ MessageSid: 'SM1', MessageStatus: 'delivered' }), r);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});
