/**
 * PeriskopeWebhookController.test.ts
 *
 * Cenários:
 * 1. assinatura — 403 se x-periskope-signature inválida
 * 2. assinatura — 403 se header ausente com secret configurado
 * 3. assinatura — aceita HMAC-SHA256 válido do raw body
 * 4. assinatura — pula validação se PERISKOPE_WEBHOOK_SECRET ausente
 * 5. from_me=true é ignorado com 200
 * 6. chat de grupo (@g.us) é ignorado
 * 7. opt-out — keyword PARAR registra em messaging_opt_out (precedência sobre roteamento numerado)
 * 8. resposta numerada — roteia via PeriskopeInboundRouter quando handled=true (não cai em awaiting_reason)
 * 9. resposta numerada — cai no fluxo awaiting_reason quando router retorna false
 * 10. texto livre — captura motivo quando worker em awaiting_reason
 * 11. texto livre — ignora quando não há estado especial
 * 12. message.ack.updated — atualiza delivery_status em messaging_outbox e whatsapp_bulk_dispatch_logs
 * 13. message.ack.updated — ack desconhecido não atualiza nada
 * 14. eventos desconhecidos (≠ message.created / message.ack.updated) são ignorados com 200
 * 15. envelope malformado (Zod) não derruba a rota — responde 200
 */

import { Request, Response } from 'express';
import { createHmac } from 'crypto';
import { PeriskopeWebhookController } from '../PeriskopeWebhookController';
import { Result } from '@shared/utils/Result';

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function envelope(data: Record<string, unknown>, event = 'message.created') {
  return { event, data, org_id: 'org-1', timestamp: '2026-07-02T12:00:00Z' };
}

function mockReq(
  body: Record<string, unknown>,
  opts: { signature?: string; rawBody?: string } = {},
): Request {
  return {
    body,
    rawBody: opts.rawBody ?? JSON.stringify(body),
    headers: opts.signature !== undefined ? { 'x-periskope-signature': opts.signature } : {},
  } as unknown as Request;
}

function sign(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

describe('PeriskopeWebhookController', () => {
  const SECRET = 'test-signing-key';
  let mockDbQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockHandleReminder: { executeTextResponse: jest.Mock };
  let mockInboundRouter: { routeNumberedReply: jest.Mock };
  let controller: PeriskopeWebhookController;

  beforeEach(() => {
    process.env.PERISKOPE_WEBHOOK_SECRET = SECRET;
    mockDbQuery = jest.fn();
    mockDb = { query: mockDbQuery };
    mockHandleReminder = {
      executeTextResponse: jest.fn().mockResolvedValue(Result.fail('No application awaiting reason')),
    };
    mockInboundRouter = {
      routeNumberedReply: jest.fn().mockResolvedValue(false),
    };
    controller = new PeriskopeWebhookController(mockDb as any, mockHandleReminder as any, mockInboundRouter as any);
  });

  afterEach(() => {
    delete process.env.PERISKOPE_WEBHOOK_SECRET;
    jest.clearAllMocks();
  });

  // ─── Assinatura ───────────────────────────────────────────────

  it('rejeita com 403 se assinatura inválida', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'hola', from_me: false });
    const req = mockReq(body, { signature: 'deadbeef' });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
  });

  it('rejeita com 403 se header ausente com secret configurado', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'hola', from_me: false });
    const req = mockReq(body);
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('aceita HMAC-SHA256 válido do raw body', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'hola', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockInboundRouter.routeNumberedReply).toHaveBeenCalledWith('+5491112345678', 'hola');
    expect(mockHandleReminder.executeTextResponse).toHaveBeenCalledWith('+5491112345678', 'hola');
  });

  it('pula validação se PERISKOPE_WEBHOOK_SECRET ausente', async () => {
    delete process.env.PERISKOPE_WEBHOOK_SECRET;
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'hola', from_me: false });
    const req = mockReq(body);
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Filtros de evento ────────────────────────────────────────

  it('ignora eventos que não são message.created nem message.ack.updated', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us' }, 'ticket.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('ignora mensagens from_me=true (outbound/agente)', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'respuesta', from_me: true });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
  });

  it('ignora chats de grupo (@g.us)', async () => {
    const body = envelope({ chat_id: '1203630000000000@g.us', body: 'hola grupo', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
  });

  // ─── Opt-out ──────────────────────────────────────────────────

  it('registra opt-out para keyword PARAR', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] }) // SELECT workers
      .mockResolvedValueOnce({ rows: [] }); // INSERT opt_out

    const body = envelope({ chat_id: '5491112345678@c.us', body: 'PARAR', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO messaging_opt_out'),
      ['worker-1', '+5491112345678'],
    );
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
    expect(mockInboundRouter.routeNumberedReply).not.toHaveBeenCalled();
  });

  // ─── Resposta numerada (item 2.3) ──────────────────────────────

  it('roteia resposta numerada via PeriskopeInboundRouter e não cai em awaiting_reason quando handled=true', async () => {
    mockInboundRouter.routeNumberedReply.mockResolvedValue(true);

    const body = envelope({ chat_id: '5491112345678@c.us', body: '1', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockInboundRouter.routeNumberedReply).toHaveBeenCalledWith('+5491112345678', '1');
    expect(mockHandleReminder.executeTextResponse).not.toHaveBeenCalled();
  });

  it('cai no fluxo awaiting_reason quando PeriskopeInboundRouter não encontra correlação (handled=false)', async () => {
    mockInboundRouter.routeNumberedReply.mockResolvedValue(false);
    mockHandleReminder.executeTextResponse.mockResolvedValue(Result.ok());

    const body = envelope({ chat_id: '5491112345678@c.us', body: '1', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockInboundRouter.routeNumberedReply).toHaveBeenCalledWith('+5491112345678', '1');
    expect(mockHandleReminder.executeTextResponse).toHaveBeenCalledWith('+5491112345678', '1');
  });

  // ─── Texto livre ──────────────────────────────────────────────

  it('captura texto livre quando worker em awaiting_reason', async () => {
    mockHandleReminder.executeTextResponse.mockResolvedValue(Result.ok());

    const body = envelope({ chat_id: '5491112345678@c.us', body: 'no puedo ese día', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHandleReminder.executeTextResponse).toHaveBeenCalledWith('+5491112345678', 'no puedo ese día');
  });

  it('responde 200 mesmo quando texto não tem estado especial', async () => {
    const body = envelope({ chat_id: '5491112345678@c.us', body: 'hola', from_me: false });
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Delivery tracking (message.ack.updated) ───────────────────

  // Semântica oficial (docs.periskope.app/api-reference/delivery-status.md):
  // 2 = delivered to WhatsApp SERVERS (⇒ 'sent'), 3 = delivered to recipients
  // (⇒ 'delivered'), 4/5 = read/played (⇒ 'read').
  it('atualiza delivery_status em messaging_outbox e whatsapp_bulk_dispatch_logs para ack=3 (delivered)', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaging_outbox
      .mockResolvedValueOnce({ rows: [] }); // UPDATE whatsapp_bulk_dispatch_logs

    const body = envelope({ message_id: 'uid-123', chat_id: '5491112345678@c.us', ack: 3 }, 'message.ack.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDbQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE messaging_outbox'),
      ['delivered', 'uid-123'],
    );
    expect(mockDbQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE whatsapp_bulk_dispatch_logs'),
      ['delivered', 'uid-123'],
    );
  });

  it('mapeia ack=2 (servidor, não destinatário) para "sent"', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const body = envelope({ message_id: 'uid-455', ack: 2 }, 'message.ack.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(mockDbQuery).toHaveBeenCalledWith(expect.any(String), ['sent', 'uid-455']);
  });

  it('mapeia ack=4 para "read"', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const body = envelope({ message_id: 'uid-456', ack: 4 }, 'message.ack.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(mockDbQuery).toHaveBeenCalledWith(expect.any(String), ['read', 'uid-456']);
  });

  it('não atualiza nada se ack é desconhecido (defensivo)', async () => {
    const body = envelope({ message_id: 'uid-789', ack: 99 }, 'message.ack.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('não atualiza nada se message_id ausente no payload de ack', async () => {
    const body = envelope({ ack: 2 }, 'message.ack.updated');
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  // ─── Envelope malformado ────────────────────────────────────────

  it('responde 200 mesmo com envelope sem campo "event" (falha no Zod)', async () => {
    const body = { data: { chat_id: '5491112345678@c.us' } };
    const raw = JSON.stringify(body);
    const req = mockReq(body, { signature: sign(raw, SECRET), rawBody: raw });
    const res = mockRes();

    await controller.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
