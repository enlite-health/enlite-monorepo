import { Request, Response } from 'express';
import { InboundWhatsAppController } from '../InboundWhatsAppController';
import { Result } from '@shared/utils/Result';

// Mock twilio.validateRequest
jest.mock('twilio', () => ({
  __esModule: true,
  default: {
    validateRequest: jest.fn().mockReturnValue(true),
  },
}));

import twilio from 'twilio';
const mockValidateRequest = twilio.validateRequest as jest.Mock;

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockReq(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  return {
    body,
    headers: { 'x-twilio-signature': 'valid-sig', ...headers },
  } as unknown as Request;
}

describe('InboundWhatsAppController', () => {
  let mockDbQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockBookSlot: { execute: jest.Mock };
  let mockHandleReminder: { execute: jest.Mock; executeTextResponse: jest.Mock };
  let controller: InboundWhatsAppController;

  beforeEach(() => {
    mockDbQuery = jest.fn();
    mockDb = { query: mockDbQuery };
    mockBookSlot = { execute: jest.fn().mockResolvedValue(Result.ok()) };
    mockHandleReminder = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
      executeTextResponse: jest.fn().mockResolvedValue(Result.fail('No application awaiting reason')),
    };
    controller = new InboundWhatsAppController(mockDb as any, mockBookSlot as any, mockHandleReminder as any);
    mockValidateRequest.mockReturnValue(true);

    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_INBOUND_WEBHOOK_URL = 'https://test.com/api/webhooks/twilio/inbound';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_INBOUND_WEBHOOK_URL;
  });

  // ─── Signature validation ─────────────────────────────────────

  it('rejeita com 403 se assinatura Twilio inválida', async () => {
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
  });

  it('rejeita com 403 se X-Twilio-Signature ausente', async () => {
    const req = mockReq(
      { From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' },
      { 'x-twilio-signature': '' },
    );
    delete (req.headers as Record<string, string | undefined>)['x-twilio-signature'];
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ─── Roteamento por template_slug + payload ────────────────────

  it('roteia slot_* para BookSlot quando template é qualified_worker_request', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_2',
      OriginalRepliedMessageSid: 'SM-abc123',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining('twilio_sid'),
      ['SM-abc123'],
    );
    expect(mockBookSlot.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'slot_2', 'SM-abc123');
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('roteia slot_* para BookSlot quando template é legacy qualified_worker (slug antigo)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-legacy',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'slot_1', 'SM-legacy');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('roteia confirm_* para HandleReminder quando template é qualified_reminder_confirm', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_confirm' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'confirm_yes',
      OriginalRepliedMessageSid: 'SM-def456',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'confirm_yes', 'SM-def456');
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Ignora mensagens de outros fluxos ─────────────────────────

  it('ignora mensagem se template_slug não pertence ao fluxo de entrevista', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'client_selection' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-other',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('roteia slot_3 para BookSlot corretamente', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_3',
      OriginalRepliedMessageSid: 'SM-slot3',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'slot_3', 'SM-slot3');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reconhece qualified_worker_response como fluxo de entrevista (sem ação)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_response' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'some_random_payload',
      OriginalRepliedMessageSid: 'SM-response',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    // Não deve chamar nenhum use case (response não tem ação associada)
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    // Mas deve responder 200 (não é "template not interview flow")
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ignora se template é interview mas payload não combina (template/payload mismatch)', async () => {
    // Template de invite mas payload de confirm
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'confirm_yes',
      OriginalRepliedMessageSid: 'SM-mismatch',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Fallback sem OriginalRepliedMessageSid ─────────────────────

  it('usa fallback por prefixo do payload se OriginalRepliedMessageSid ausente', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    // Não fez lookup na outbox (sem SID)
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockBookSlot.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'slot_1', '');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('usa fallback confirm_* se OriginalRepliedMessageSid ausente', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'confirm_no' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'confirm_no', '');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('usa fallback se SID presente mas outbox não encontra', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-unknown',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalledWith('whatsapp:+5491112345678', 'slot_1', 'SM-unknown');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Roteamento reschedule_* ─────────────────────────────────

  it('roteia reschedule_yes para HandleReminder via template', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_reschedule' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'reschedule_yes',
      OriginalRepliedMessageSid: 'SM-reschedule',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalledWith(
      'whatsapp:+5491112345678', 'reschedule_yes', 'SM-reschedule',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('roteia reschedule_no para HandleReminder via template', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_reschedule' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'reschedule_no',
      OriginalRepliedMessageSid: 'SM-reschedule-no',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalledWith(
      'whatsapp:+5491112345678', 'reschedule_no', 'SM-reschedule-no',
    );
  });

  it('roteia reschedule_yes via fallback sem SID', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'reschedule_yes' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalledWith(
      'whatsapp:+5491112345678', 'reschedule_yes', '',
    );
  });

  it('loga warn se reschedule via template falha', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_reschedule' }] });
    mockHandleReminder.execute.mockResolvedValue(Result.fail('Invalid transition'));

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'reschedule_yes',
      OriginalRepliedMessageSid: 'SM-fail',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('loga warn se reschedule via fallback falha', async () => {
    mockHandleReminder.execute.mockResolvedValue(Result.fail('Invalid transition'));

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'reschedule_no' });
    const res = mockRes();

    await controller.handleInbound(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Texto livre (awaiting_reason) ────────────────────────────

  it('captura texto livre quando worker em awaiting_reason', async () => {
    mockHandleReminder.executeTextResponse.mockResolvedValue(Result.ok());

    const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'No tengo tiempo' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.executeTextResponse).toHaveBeenCalledWith(
      'whatsapp:+5491112345678',
      'No tengo tiempo',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ignora texto livre quando worker NAO esta em awaiting_reason', async () => {
    // Default mock: executeTextResponse returns fail
    const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.executeTextResponse).toHaveBeenCalled();
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('trata excecao em tryHandleTextResponse gracefully', async () => {
    mockHandleReminder.executeTextResponse.mockRejectedValue(new Error('DB crash'));

    const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Motivo qualquer' });
    const res = mockRes();

    await controller.handleInbound(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Handover Twilio → Periskope (texto livre não-roteável) ───

  describe('handover trigger (PERISKOPE_HANDOVER_ENABLED)', () => {
    let mockTriggerHandover: { execute: jest.Mock };

    beforeEach(() => {
      mockTriggerHandover = { execute: jest.fn().mockResolvedValue(Result.ok()) };
    });

    afterEach(() => {
      delete process.env.PERISKOPE_HANDOVER_ENABLED;
    });

    it('flag OFF (default) → NÃO consulta worker nem dispara handover', async () => {
      delete process.env.PERISKOPE_HANDOVER_ENABLED;
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(mockTriggerHandover.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('flag ON, worker resolvido com messaging_channel=twilio → dispara handover', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'w-handover-1', messaging_channel: 'twilio' }] });

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(mockTriggerHandover.execute).toHaveBeenCalledWith('w-handover-1', '+5491112345678');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('flag ON, worker já em periskope → NÃO dispara handover', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'w-handover-2', messaging_channel: 'periskope' }] });

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(mockTriggerHandover.execute).not.toHaveBeenCalled();
    });

    it('flag ON, worker não encontrado por telefone → NÃO dispara handover', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );
      mockDbQuery.mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(mockTriggerHandover.execute).not.toHaveBeenCalled();
    });

    it('flag ON mas triggerHandoverUseCase não injetado → não quebra, responde 200', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      const withoutHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any,
      );

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withoutHandover.handleInbound(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handover.execute falha (Result.fail) → loga warning, ainda responde 200', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      mockTriggerHandover.execute.mockResolvedValue(Result.fail('boom'));
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'w-handover-3', messaging_channel: 'twilio' }] });

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('erro na consulta do worker (db.query lança) → capturado, ainda responde 200', async () => {
      process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
      const withHandover = new InboundWhatsAppController(
        mockDb as any, mockBookSlot as any, mockHandleReminder as any, mockTriggerHandover as any,
      );
      mockDbQuery.mockRejectedValueOnce(new Error('DB down'));

      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
      const res = mockRes();
      await withHandover.handleInbound(req, res);

      expect(mockTriggerHandover.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ─── Mensagens sem ButtonPayload ───────────────────────────────

  it('trata body sem From e ButtonPayload (nullish coalesce)', async () => {
    const req = mockReq({});
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Resiliência ───────────────────────────────────────────────

  it('responde 200 mesmo se use case falhar', async () => {
    mockBookSlot.execute.mockResolvedValue(Result.fail('Worker not found'));

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('responde 200 mesmo se use case lançar exceção', async () => {
    mockBookSlot.execute.mockRejectedValue(new Error('DB connection lost'));

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('responde 200 mesmo se lookup na outbox falhar', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('DB timeout'));

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-fail',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Use case failure com template slug identificado ────────────

  it('loga warn se BookSlot falha com template slug identificado', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });
    mockBookSlot.execute.mockResolvedValue(Result.fail('No pending interview'));

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-fail-routed',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('loga warn se HandleReminder falha com template slug identificado', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_confirm' }] });
    mockHandleReminder.execute.mockResolvedValue(Result.fail('Reminder not found'));

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'confirm_yes',
      OriginalRepliedMessageSid: 'SM-reminder-fail',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('loga warn se HandleReminder (fallback) falha', async () => {
    mockHandleReminder.execute.mockResolvedValue(Result.fail('Something wrong'));

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'confirm_no',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockHandleReminder.execute).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Fallback com payload desconhecido ──────────────────────────

  it('ignora payload desconhecido no fallback (sem SID)', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'unknown_action' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Validação via AccountSid (Studio Flow) ──────────────────

  it('aceita request com assinatura inválida se AccountSid bate (Studio Flow)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      AccountSid: 'AC-test-sid',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);

    delete process.env.TWILIO_ACCOUNT_SID;
  });

  it('aceita request sem X-Twilio-Signature se AccountSid bate', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';

    const req = mockReq(
      { From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1', AccountSid: 'AC-test-sid' },
      {},
    );
    delete (req.headers as Record<string, string | undefined>)['x-twilio-signature'];
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockBookSlot.execute).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);

    delete process.env.TWILIO_ACCOUNT_SID;
  });

  it('rejeita request sem X-Twilio-Signature se AccountSid não bate', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';

    const req = mockReq(
      { From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1', AccountSid: 'AC-wrong-sid' },
      {},
    );
    delete (req.headers as Record<string, string | undefined>)['x-twilio-signature'];
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockBookSlot.execute).not.toHaveBeenCalled();

    delete process.env.TWILIO_ACCOUNT_SID;
  });

  // ─── Validação skipped em dev ──────────────────────────────────

  it('pula validação se TWILIO_INBOUND_WEBHOOK_URL não configurado', async () => {
    delete process.env.TWILIO_INBOUND_WEBHOOK_URL;
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockBookSlot.execute).toHaveBeenCalled();
  });

  // ─── inferButtonPayloadFromBody (Body → ButtonPayload via Content API) ───

  describe('inferButtonPayloadFromBody (sem ButtonPayload, usa Body)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.TWILIO_ACCOUNT_SID;
    });

    it('infere ButtonPayload a partir do Body usando Content API', async () => {
      // Ordem: inferência (A: outbox slug, B: content_sid) → roteamento (C: outbox slug)
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] })                 // B: content_sid
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });  // C: roteamento outbox

      // Mock fetch → Twilio Content API
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [
                { id: 'slot_1', title: 'Opción 1' },
                { id: 'slot_2', title: 'Opción 2' },
                { id: 'slot_3', title: 'Opción 3' },
              ],
            },
          },
        }),
      });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 2',
        OriginalRepliedMessageSid: 'SM-infer',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).toHaveBeenCalledWith(
        'whatsapp:+5491112345678', 'slot_2', 'SM-infer',
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('inferência case-insensitive: "opción 1" match "Opción 1"', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] })                 // B: content_sid
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });  // C: roteamento outbox

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [
                { id: 'slot_1', title: 'Opción 1' },
              ],
            },
          },
        }),
      });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'opción 1',
        OriginalRepliedMessageSid: 'SM-case',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).toHaveBeenCalledWith(
        'whatsapp:+5491112345678', 'slot_1', 'SM-case',
      );
    });

    it('retorna vazio se Body não matcha nenhum botão', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [
                { id: 'slot_1', title: 'Opción 1' },
              ],
            },
          },
        }),
      });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Texto qualquer',
        OriginalRepliedMessageSid: 'SM-nomatch',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      // Sem ButtonPayload inferido → ignora
      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se outbox não encontra slug', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [] });  // outbox: not found

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-nosid',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se template não tem content_sid', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })
        .mockResolvedValueOnce({ rows: [{ content_sid: null }] });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-nocid',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se Content API retorna erro', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-apierr',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se TWILIO_ACCOUNT_SID não configurado', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;

      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-noenv',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('usa cache na segunda chamada (não faz fetch de novo)', async () => {
      // Primeira chamada: popula cache
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-cached' }] })                   // B: content_sid
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });  // C: roteamento outbox

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [{ id: 'slot_1', title: 'Opción 1' }],
            },
          },
        }),
      });
      globalThis.fetch = mockFetch;

      const req1 = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-cache1',
      });
      await controller.handleInbound(req1, mockRes());

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Segunda chamada: deve usar cache (mesmo content_sid → cache hit)
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-cached' }] })                   // B: content_sid
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] });  // C: roteamento outbox

      const req2 = mockReq({
        From: 'whatsapp:+5491199999999',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-cache2',
      });
      await controller.handleInbound(req2, mockRes());

      // fetch NÃO foi chamado de novo (cache hit)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('trata exceção no inferButtonPayloadFromBody gracefully', async () => {
      mockDbQuery.mockRejectedValueOnce(new Error('DB crash'));

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-crash',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se Body está vazio', async () => {
      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: '',
        OriginalRepliedMessageSid: 'SM-empty',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      // Body vazio → não tenta inferir → ignora
      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se OriginalRepliedMessageSid ausente (sem inferência)', async () => {
      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('retorna vazio se template não tem quick-reply actions', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_worker_request' }] })
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-noqr' }] });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/text': { body: 'Some text' },
          },
        }),
      });

      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
        OriginalRepliedMessageSid: 'SM-noqr',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockBookSlot.execute).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
