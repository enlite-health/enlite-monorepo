import { Request, Response } from 'express';
import { InboundWhatsAppController } from '../InboundWhatsAppController';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';

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
  let controller: InboundWhatsAppController;

  beforeEach(() => {
    mockDbQuery = jest.fn();
    mockDb = { query: mockDbQuery };
    controller = new InboundWhatsAppController(mockDb as any);
    mockValidateRequest.mockReturnValue(true);

    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_INBOUND_WEBHOOK_URL = 'https://test.com/api/webhooks/twilio/inbound';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_INBOUND_WEBHOOK_URL;
    delete process.env.CHATWOOT_INBOUND_MIRROR_ENABLED;
  });

  // ─── Espelho do inbound pro Chatwoot (faz a Luz ver e responder) ───
  describe('mirror inbound → Chatwoot', () => {
    it('texto livre não-roteável + flag ON → espelha como incoming', async () => {
      const mirror = { mirrorIncomingMessage: jest.fn().mockResolvedValue(undefined) };
      const c = new InboundWhatsAppController(
        mockDb as any, undefined, mirror as any,
      );
      process.env.CHATWOOT_INBOUND_MIRROR_ENABLED = 'true';
      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'hola, tengo una duda', MessageSid: 'SMabc' });

      await c.handleInbound(req, mockRes());

      expect(mirror.mirrorIncomingMessage).toHaveBeenCalledWith({
        phone: '+5491112345678',
        content: 'hola, tengo una duda',
        externalId: 'SMabc',
      });
    });

    it('flag OFF → NÃO espelha (deploy neutro)', async () => {
      const mirror = { mirrorIncomingMessage: jest.fn() };
      const c = new InboundWhatsAppController(
        mockDb as any, undefined, mirror as any,
      );
      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'hola', MessageSid: 'SMx' });

      await c.handleInbound(req, mockRes());

      expect(mirror.mirrorIncomingMessage).not.toHaveBeenCalled();
    });

    it('opt-out ("baja") NÃO vira mirror (intercepta antes)', async () => {
      const mirror = { mirrorIncomingMessage: jest.fn() };
      const c = new InboundWhatsAppController(
        mockDb as any, undefined, mirror as any,
      );
      process.env.CHATWOOT_INBOUND_MIRROR_ENABLED = 'true';
      mockDbQuery.mockResolvedValue({ rows: [] }); // handleOptOut: worker lookup
      const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'baja', MessageSid: 'SMz' });

      await c.handleInbound(req, mockRes());

      expect(mirror.mirrorIncomingMessage).not.toHaveBeenCalled();
    });
  });

  // ─── PII guard — opt-out nunca loga telefone cru (achado do gate 12/09) ──
  // Mesmo bug do controller Periskope, canal Twilio: `logger.child({ phone, ... })`
  // publicava o telefone CRU no contexto de todo log do handler.
  describe('PII guard — handleOptOut (canal Twilio)', () => {
    it('telefone mascarado no logger.child, nunca o valor cru', async () => {
      const childSpy = jest.spyOn(logger, 'child');
      mockDbQuery.mockResolvedValue({ rows: [] }); // worker não encontrado, mas o log já foi montado
      const req = mockReq({ From: 'whatsapp:+5491198887766', Body: 'baja', MessageSid: 'SMz' });

      await controller.handleInbound(req, mockRes());

      const optOutChildCall = childSpy.mock.calls.find(
        (c) => (c[0] as Record<string, unknown>)?.handler === 'OptOut',
      );
      expect(optOutChildCall).toBeDefined();
      const ctx = optOutChildCall![0] as Record<string, unknown>;
      expect(ctx.phone).toBe('+549******7766');
      expect(JSON.stringify(ctx)).not.toContain('5491198887766');
      expect(JSON.stringify(ctx)).not.toContain('1198887766');
      childSpy.mockRestore();
    });

    // Sabotagem: reproduz em CÓPIA o comportamento ANTIGO (telefone cru no
    // child) — prova que a asserção acima é capaz de detectar o vazamento.
    it('sabotagem: reproduzindo o logger.child ANTIGO (telefone cru), a asserção acima cairia', () => {
      const RAW_PHONE = '+5491198887766';
      const oldStyleContext = { phone: RAW_PHONE, keyword: 'baja', handler: 'OptOut' };
      expect(JSON.stringify(oldStyleContext)).toContain('5491198887766'); // confirma: formato antigo VAZAVA
      expect(oldStyleContext.phone).not.toBe(maskPhoneForLog(RAW_PHONE));
    });
  });

  // ─── Signature validation ─────────────────────────────────────

  it('rejeita com 403 se assinatura Twilio inválida', async () => {
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
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

  it('botão de convite/lembrete antigo (slot_*, confirm_*, reschedule_*) é ignorado: 200, sem lookup nem escrita (spec 052)', async () => {
    for (const payload of ['slot_2', 'confirm_yes', 'reschedule_no']) {
      const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: payload, OriginalRepliedMessageSid: 'SM-abc123' });
      const res = mockRes();

      await controller.handleInbound(req, res);

      expect(mockDbQuery).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });

  it('ignora mensagem se template_slug não pertence ao fluxo de entrevista', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ template_slug: 'client_selection' }] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-other',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

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

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Fallback sem OriginalRepliedMessageSid ─────────────────────

  it('slot_1 sem OriginalRepliedMessageSid: ignorado (sem lookup na outbox, nenhum use case) — spec 052', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'slot_1' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('slot_1 com SID que a outbox não encontra: ignorado (nenhum use case) — spec 052', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'slot_1',
      OriginalRepliedMessageSid: 'SM-unknown',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Roteamento reschedule_* ─────────────────────────────────

  // ─── Texto livre (awaiting_reason) ────────────────────────────

  it('texto livre sem estado especial: ignorado, responde 200 (spec 052: awaiting_reason saiu)', async () => {
    // Default mock: executeTextResponse returns fail
    const req = mockReq({ From: 'whatsapp:+5491112345678', Body: 'Hola!' });
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
        mockDb as any, mockTriggerHandover as any,
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
        mockDb as any, mockTriggerHandover as any,
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
        mockDb as any, mockTriggerHandover as any,
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
        mockDb as any, mockTriggerHandover as any,
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
        mockDb as any,
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
        mockDb as any, mockTriggerHandover as any,
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
        mockDb as any, mockTriggerHandover as any,
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

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Resiliência ───────────────────────────────────────────────

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

  // ─── Fallback com payload desconhecido ──────────────────────────

  it('ignora payload desconhecido no fallback (sem SID)', async () => {
    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'unknown_action' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── Validação via AccountSid (Studio Flow) ──────────────────

  it('aceita request com assinatura inválida se AccountSid bate (Studio Flow)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({
      From: 'whatsapp:+5491112345678',
      ButtonPayload: 'confirm_yes',
      AccountSid: 'AC-test-sid',
    });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    delete process.env.TWILIO_ACCOUNT_SID;
  });

  it('aceita request sem X-Twilio-Signature se AccountSid bate', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';

    const req = mockReq(
      { From: 'whatsapp:+5491112345678', ButtonPayload: 'confirm_yes', AccountSid: 'AC-test-sid' },
      {},
    );
    delete (req.headers as Record<string, string | undefined>)['x-twilio-signature'];
    const res = mockRes();

    await controller.handleInbound(req, res);

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

    delete process.env.TWILIO_ACCOUNT_SID;
  });

  // ─── Validação skipped em dev ──────────────────────────────────

  it('pula validação se TWILIO_INBOUND_WEBHOOK_URL não configurado', async () => {
    delete process.env.TWILIO_INBOUND_WEBHOOK_URL;
    mockValidateRequest.mockReturnValue(false);

    const req = mockReq({ From: 'whatsapp:+5491112345678', ButtonPayload: 'confirm_yes' });
    const res = mockRes();

    await controller.handleInbound(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ─── inferButtonPayloadFromBody (Body → ButtonPayload via Content API) ───

  describe('inferButtonPayloadFromBody (sem ButtonPayload, usa Body)', () => {
    let originalFetch: typeof globalThis.fetch;
    let infoSpy: jest.SpyInstance;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.TWILIO_ACCOUNT_SID;
      infoSpy.mockRestore();
    });

    it('infere ButtonPayload a partir do Body usando Content API', async () => {
      // Ordem: inferência (A: outbox slug, B: content_sid); o roteamento por template saiu (spec 052)
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_confirm' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] });                // B: content_sid

      // Mock fetch → Twilio Content API
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [
                { id: 'confirm_yes', title: 'Opción 1' },
                { id: 'confirm_no', title: 'Opción 2' },
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

      expect(infoSpy).toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.objectContaining({ buttonPayload: 'confirm_no' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('inferência case-insensitive: "opción 1" match "Opción 1"', async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'qualified_reminder_confirm' }] })  // A: inferência outbox
        .mockResolvedValueOnce({ rows: [{ content_sid: 'HX-test-123' }] });                // B: content_sid

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          types: {
            'twilio/quick-reply': {
              actions: [
                { id: 'confirm_yes', title: 'Opción 1' },
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

      expect(infoSpy).toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.objectContaining({ buttonPayload: 'confirm_yes' }));
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
        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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
        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
    });

    it('retorna vazio se OriginalRepliedMessageSid ausente (sem inferência)', async () => {
      const req = mockReq({
        From: 'whatsapp:+5491112345678',
        Body: 'Opción 1',
      });
      const res = mockRes();

      await controller.handleInbound(req, res);

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
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

        expect(res.status).toHaveBeenCalledWith(200);

      expect(infoSpy).not.toHaveBeenCalledWith('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', expect.anything());
    });
  });
});
