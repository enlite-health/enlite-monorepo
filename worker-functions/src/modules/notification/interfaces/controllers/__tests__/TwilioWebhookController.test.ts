/**
 * TwilioWebhookController.test.ts
 *
 * Foco: AUTO-BLOQUEIO por falha de entrega repetida (incidente 2026-07-10, parte
 * "futuro"). O guard do OutboxProcessor enforce messaging_opt_out; este callback
 * ALIMENTA essa lista quando um número acumula >=2 undelivered/failed.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockQuery }) }),
  },
}));

import { Request, Response } from 'express';
import { TwilioWebhookController } from '../TwilioWebhookController';

function mockRes() {
  return { status: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
}
function mockReq(body: Record<string, string>): Request {
  return { body, headers: {} } as unknown as Request;
}

describe('TwilioWebhookController — auto-bloqueio por falha repetida', () => {
  let controller: TwilioWebhookController;

  beforeEach(() => {
    mockQuery.mockReset();
    // Sem callback URL/token -> validação de assinatura é pulada (dev/test).
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    controller = new TwilioWebhookController();
  });

  it('undelivered + worker já com >=2 falhas -> insere em messaging_opt_out', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE bulk_dispatch_logs
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaging_outbox
      .mockResolvedValueOnce({ rows: [{ worker_id: 'w-1', phone: '+5491100000000', fails: '2' }] }) // SELECT fails
      .mockResolvedValueOnce({ rows: [] }); // INSERT opt_out

    const res = mockRes();
    await controller.handleStatusCallback(mockReq({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '63024' }), res);

    const insert = mockQuery.mock.calls[3];
    expect(insert[0]).toContain('INSERT INTO messaging_opt_out');
    expect(insert[0]).toContain('undelivered_cap');
    expect(insert[1]).toEqual(['w-1', '+5491100000000']);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('undelivered + worker com <2 falhas -> NÃO insere', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ worker_id: 'w-2', phone: '+5491100000001', fails: '1' }] });

    await controller.handleStatusCallback(mockReq({ MessageSid: 'SM2', MessageStatus: 'undelivered' }), mockRes());

    // só as 2 updates + o select; NENHUM insert (4ª query)
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls.every(c => !String(c[0]).includes('INSERT INTO messaging_opt_out'))).toBe(true);
  });

  it('status delivered (sucesso) -> nem tenta suprimir', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await controller.handleStatusCallback(mockReq({ MessageSid: 'SM3', MessageStatus: 'delivered' }), mockRes());

    expect(mockQuery).toHaveBeenCalledTimes(2); // só as 2 updates, sem SELECT de falhas
  });

  it('persiste ErrorCode em error_message (COALESCE) no update do log', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await controller.handleStatusCallback(mockReq({ MessageSid: 'SM4', MessageStatus: 'failed', ErrorCode: '63005' }), mockRes());

    const logUpdate = mockQuery.mock.calls[0];
    expect(logUpdate[0]).toContain('error_message = COALESCE');
    expect(logUpdate[1]).toEqual(['failed', 'SM4', '63005']);
  });
});
