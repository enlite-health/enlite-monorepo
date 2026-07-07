/**
 * TriggerWorkerHandoverUseCase.test.ts
 *
 * Cenários:
 * 1. worker em 'twilio' → flipa pra 'periskope', envia os 2 templates, cria ticket
 * 2. guard idempotente/anti-race: UPDATE afeta 0 linhas (worker já não está em
 *    'twilio') → aborta silenciosamente, NENHUM envio nem ticket
 * 3. template Twilio ausente (sendWhatsApp falha) → loga warning e SEGUE (não
 *    aborta o fluxo — periskope e ticket ainda são tentados)
 * 4. template Periskope falha → mesma tolerância, resultado reporta periskopeSent=false
 * 5. ticketService retorna false (best-effort) → não propaga, resultado reporta ticketCreated=false
 * 6. UPDATE usa guard WHERE messaging_channel='twilio' (SQL contém a cláusula)
 */
import { TriggerWorkerHandoverUseCase } from '../TriggerWorkerHandoverUseCase';
import { Result } from '@shared/utils/Result';

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
}));

function makeMessaging(success = true) {
  return {
    sendWhatsApp: jest.fn().mockResolvedValue(
      success
        ? Result.ok({ externalId: 'sid-1', status: 'queued', to: '+5491100000000' })
        : Result.fail('Template não encontrado ou inativo'),
    ),
    sendWithContentSid: jest.fn(),
  };
}

describe('TriggerWorkerHandoverUseCase', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let twilioMessaging: ReturnType<typeof makeMessaging>;
  let periskopeMessaging: ReturnType<typeof makeMessaging>;
  let ticketService: { createTicket: jest.Mock };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    twilioMessaging = makeMessaging(true);
    periskopeMessaging = makeMessaging(true);
    ticketService = { createTicket: jest.fn().mockResolvedValue(true) };
  });

  function makeUseCase() {
    return new TriggerWorkerHandoverUseCase(
      mockDb as any,
      twilioMessaging as any,
      periskopeMessaging as any,
      ticketService as any,
    );
  }

  it('worker em twilio → flipa, envia os 2 templates e cria ticket', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w-1' }], rowCount: 1 });

    const uc = makeUseCase();
    const result = await uc.execute('w-1', '+5491122334455');

    expect(result.isSuccess).toBe(true);
    const value = result.getValue()!;
    expect(value.flipped).toBe(true);
    expect(value.twilioSent).toBe(true);
    expect(value.periskopeSent).toBe(true);
    expect(value.ticketCreated).toBe(true);

    expect(twilioMessaging.sendWhatsApp).toHaveBeenCalledWith({
      to: '+5491122334455',
      templateSlug: 'handover_seguimos_por_aca',
    });
    expect(periskopeMessaging.sendWhatsApp).toHaveBeenCalledWith({
      to: '+5491122334455',
      templateSlug: 'handover_primer_saludo',
    });
    expect(ticketService.createTicket).toHaveBeenCalledWith('+5491122334455', expect.stringContaining('w-1'));
  });

  it('guard idempotente: UPDATE afeta 0 linhas → aborta sem enviar nada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const uc = makeUseCase();
    const result = await uc.execute('w-2', '+5491122334455');

    expect(result.isSuccess).toBe(true);
    const value = result.getValue()!;
    expect(value.flipped).toBe(false);
    expect(value.twilioSent).toBe(false);
    expect(value.periskopeSent).toBe(false);
    expect(value.ticketCreated).toBe(false);

    expect(twilioMessaging.sendWhatsApp).not.toHaveBeenCalled();
    expect(periskopeMessaging.sendWhatsApp).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('template Twilio falha (não encontrado) → loga warning e SEGUE pro Periskope + ticket', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w-3' }], rowCount: 1 });
    twilioMessaging.sendWhatsApp.mockResolvedValue(Result.fail('Template não encontrado ou inativo'));

    const uc = makeUseCase();
    const result = await uc.execute('w-3', '+5491122334455');

    expect(result.isSuccess).toBe(true);
    const value = result.getValue()!;
    expect(value.flipped).toBe(true);
    expect(value.twilioSent).toBe(false);
    expect(value.periskopeSent).toBe(true);
    expect(value.ticketCreated).toBe(true);
    expect(periskopeMessaging.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('template Periskope falha → periskopeSent=false, resto do fluxo intacto', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w-4' }], rowCount: 1 });
    periskopeMessaging.sendWhatsApp.mockResolvedValue(Result.fail('Template não encontrado ou inativo'));

    const uc = makeUseCase();
    const result = await uc.execute('w-4', '+5491122334455');

    expect(result.isSuccess).toBe(true);
    const value = result.getValue()!;
    expect(value.periskopeSent).toBe(false);
    expect(value.ticketCreated).toBe(true);
  });

  it('ticketService best-effort retorna false → não propaga, resultado reporta ticketCreated=false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w-5' }], rowCount: 1 });
    ticketService.createTicket.mockResolvedValue(false);

    const uc = makeUseCase();
    const result = await uc.execute('w-5', '+5491122334455');

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()!.ticketCreated).toBe(false);
  });

  it('UPDATE usa guard idempotente WHERE messaging_channel=twilio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w-6' }], rowCount: 1 });

    const uc = makeUseCase();
    await uc.execute('w-6', '+5491122334455');

    const updateCall = mockQuery.mock.calls[0];
    expect(updateCall[0]).toContain("messaging_channel = 'periskope'");
    expect(updateCall[0]).toContain("messaging_channel = 'twilio'");
    expect(updateCall[1]).toEqual(['w-6']);
  });
});
