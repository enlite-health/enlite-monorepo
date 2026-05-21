/**
 * TwilioMessagingService.test.ts
 *
 * Testa o envio de mensagens WhatsApp via Twilio.
 *
 * Cenários:
 * 1. sendWhatsApp — envia free-form quando template não tem contentSid
 * 2. sendWhatsApp — envia via Content API quando template tem contentSid
 * 3. sendWhatsApp — mapeia variáveis para posicionais via Content API (contentVariables)
 * 4. sendWhatsApp — retorna fail se serviço não configurado
 * 5. sendWhatsApp — retorna fail se número inválido
 * 6. sendWhatsApp — retorna fail se template não encontrado
 * 7. sendWhatsApp — retorna fail em erro do Twilio
 * 8. sendWithContentSid — envia mensagem via Content API diretamente
 * 9. sendWithContentSid — retorna fail se serviço não configurado
 * 10. sendWithContentSid — retorna fail se número inválido
 * 11. sendWithContentSid — retorna fail em erro do Twilio
 * 12. mapToContentVariables — mapeia variáveis na ordem de aparição no body
 * 13. mapToContentVariables — ignora variáveis duplicadas no body
 * 14. mapToContentVariables — retorna string vazia para variável ausente
 * 15. interpolate — mantém placeholder se variável não fornecida
 */

import { TwilioMessagingService } from '../TwilioMessagingService';

// Mock twilio
const mockCreate = jest.fn();
jest.mock('twilio', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

describe('TwilioMessagingService', () => {
  let service: TwilioMessagingService;
  let mockTemplateRepo: { findBySlug: jest.Mock };

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
    delete process.env.TWILIO_STATUS_CALLBACK_URL;

    mockTemplateRepo = {
      findBySlug: jest.fn(),
    };

    service = new TwilioMessagingService(mockTemplateRepo as any);
    mockCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WHATSAPP_NUMBER;
    jest.clearAllMocks();
  });

  // ─── sendWhatsApp ─────────────────────────────────────────────

  describe('sendWhatsApp', () => {
    it('envia free-form quando template não tem contentSid', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'welcome',
        body: 'Hola {{name}}!',
        contentSid: null,
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM123', status: 'queued' });

      const result = await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'welcome',
        variables: { name: 'Juan' },
      });

      expect(result.isSuccess).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Hola Juan!',
          to: 'whatsapp:+5491100001111',
        }),
      );
      // Não deve ter contentSid nem contentVariables
      expect(mockCreate.mock.calls[0][0].contentSid).toBeUndefined();
      expect(mockCreate.mock.calls[0][0].contentVariables).toBeUndefined();
    });

    it('envia via Content API quando template tem contentSid', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'qualified_interview_invite',
        body: 'Hola {{name}}! Elija: 1) {{option_1}} 2) {{option_2}} 3) {{option_3}}',
        contentSid: 'HXabc123',
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM456', status: 'queued' });

      const result = await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'qualified_interview_invite',
        variables: { name: 'María', option_1: 'Lun 07/04 10:00', option_2: 'Mar 08/04 15:00', option_3: 'Mié 09/04 09:00' },
      });

      expect(result.isSuccess).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          contentSid: 'HXabc123',
          contentVariables: JSON.stringify({
            '1': 'María',
            '2': 'Lun 07/04 10:00',
            '3': 'Mar 08/04 15:00',
            '4': 'Mié 09/04 09:00',
          }),
        }),
      );
      // Não deve ter body (Content API substitui)
      expect(mockCreate.mock.calls[0][0].body).toBeUndefined();
    });

    it('mapeia variáveis para posicionais via contentVariables (ordem do body)', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'test_tpl',
        body: 'Hello {{greeting}}, meet at {{place}} on {{date}}',
        contentSid: 'HXtest',
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM789', status: 'queued' });

      await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'test_tpl',
        variables: { greeting: 'Hi', place: 'Office', date: '2026-04-07' },
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const contentVars = JSON.parse(callArgs.contentVariables);
      expect(contentVars).toEqual({
        '1': 'Hi',
        '2': 'Office',
        '3': '2026-04-07',
      });
    });

    it('retorna fail se serviço não configurado', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      const unconfigured = new TwilioMessagingService(mockTemplateRepo as any);

      const result = await unconfigured.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'welcome',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('not configured');
    });

    it('retorna fail se número inválido', async () => {
      const result = await service.sendWhatsApp({
        to: '123',
        templateSlug: 'welcome',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Invalid phone');
    });

    it('retorna fail se template não encontrado', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce(null);

      const result = await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'nonexistent',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('nonexistent');
    });

    it('retorna fail em erro do Twilio', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'welcome',
        body: 'Hola {{name}}!',
        contentSid: null,
        isActive: true,
      });
      mockCreate.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      const result = await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'welcome',
        variables: { name: 'Juan' },
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Rate limit exceeded');
    });

    it('inclui statusCallback quando TWILIO_STATUS_CALLBACK_URL configurado', async () => {
      process.env.TWILIO_STATUS_CALLBACK_URL = 'https://example.com/status';
      service = new TwilioMessagingService(mockTemplateRepo as any);

      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'welcome',
        body: 'Hola!',
        contentSid: null,
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM111', status: 'queued' });

      await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'welcome',
      });

      expect(mockCreate.mock.calls[0][0].statusCallback).toBe('https://example.com/status');

      delete process.env.TWILIO_STATUS_CALLBACK_URL;
    });

    it('envia Content API com statusCallback quando ambos configurados', async () => {
      process.env.TWILIO_STATUS_CALLBACK_URL = 'https://example.com/cb';
      service = new TwilioMessagingService(mockTemplateRepo as any);

      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'test',
        body: 'Hi {{name}}',
        contentSid: 'HXcb',
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM-cb', status: 'queued' });

      await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'test',
        variables: { name: 'Test' },
      });

      expect(mockCreate.mock.calls[0][0].statusCallback).toBe('https://example.com/cb');
      expect(mockCreate.mock.calls[0][0].contentSid).toBe('HXcb');

      delete process.env.TWILIO_STATUS_CALLBACK_URL;
    });

    it('envia free-form sem variáveis quando não fornecidas', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValueOnce({
        slug: 'no_vars',
        body: 'Mensaje fijo sin variables',
        contentSid: null,
        isActive: true,
      });
      mockCreate.mockResolvedValueOnce({ sid: 'SM-nv', status: 'queued' });

      const result = await service.sendWhatsApp({
        to: '+5491100001111',
        templateSlug: 'no_vars',
      });

      expect(result.isSuccess).toBe(true);
      expect(mockCreate.mock.calls[0][0].body).toBe('Mensaje fijo sin variables');
    });
  });

  // ─── sendWithContentSid ───────────────────────────────────────

  describe('sendWithContentSid', () => {
    it('envia mensagem via Content API diretamente', async () => {
      mockCreate.mockResolvedValueOnce({ sid: 'SM-direct-1', status: 'queued' });

      const result = await service.sendWithContentSid(
        '+5491100001111',
        'HXdirect123',
        { '1': 'María', '2': 'Lun 07/04', '3': 'Mar 08/04' },
      );

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().externalId).toBe('SM-direct-1');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          contentSid: 'HXdirect123',
          contentVariables: JSON.stringify({ '1': 'María', '2': 'Lun 07/04', '3': 'Mar 08/04' }),
          to: 'whatsapp:+5491100001111',
          from: 'whatsapp:+14155238886',
        }),
      );
    });

    it('retorna fail se serviço não configurado', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      const unconfigured = new TwilioMessagingService(mockTemplateRepo as any);

      const result = await unconfigured.sendWithContentSid(
        '+5491100001111',
        'HXtest',
        { '1': 'value' },
      );

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('not configured');
    });

    it('retorna fail se número inválido', async () => {
      const result = await service.sendWithContentSid(
        '123',
        'HXtest',
        { '1': 'value' },
      );

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Invalid phone');
    });

    it('retorna fail em erro do Twilio', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Account suspended'));

      const result = await service.sendWithContentSid(
        '+5491100001111',
        'HXtest',
        { '1': 'value' },
      );

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Account suspended');
    });

    it('inclui statusCallback quando variável de ambiente está definida', async () => {
      process.env.TWILIO_STATUS_CALLBACK_URL = 'https://example.com/status';
      service = new TwilioMessagingService(mockTemplateRepo as any);

      mockCreate.mockResolvedValueOnce({ sid: 'SM-cb', status: 'queued' });

      await service.sendWithContentSid(
        '+5491100001111',
        'HXtest',
        { '1': 'value' },
      );

      expect(mockCreate.mock.calls[0][0].statusCallback).toBe('https://example.com/status');
      delete process.env.TWILIO_STATUS_CALLBACK_URL;
    });
  });

  // ─── normalizeNumber (testado via sendWhatsApp) ────────────────

  describe('normalizeNumber (via sendWhatsApp)', () => {
    beforeEach(() => {
      mockTemplateRepo.findBySlug.mockResolvedValue({
        slug: 'tpl',
        body: 'Hi',
        contentSid: null,
        isActive: true,
      });
      mockCreate.mockResolvedValue({ sid: 'SM', status: 'queued' });
    });

    it('normaliza número argentino de 10 dígitos (adiciona +54)', async () => {
      await service.sendWhatsApp({ to: '1122334455', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+541122334455');
    });

    it('normaliza número argentino de 13 dígitos com DDI 54 sem +', async () => {
      await service.sendWhatsApp({ to: '5491122334455', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+5491122334455');
    });

    it('normaliza número brasileiro de 13 dígitos com DDI 55 sem +', async () => {
      await service.sendWhatsApp({ to: '5511987654321', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+5511987654321');
    });

    it('adiciona + para números >= 11 dígitos sem DDI conhecido', async () => {
      await service.sendWhatsApp({ to: '44207946000', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+44207946000');
    });

    it('aceita número já em formato E.164', async () => {
      await service.sendWhatsApp({ to: '+5491122334455', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+5491122334455');
    });

    it('remove caracteres não numéricos', async () => {
      await service.sendWhatsApp({ to: '+54 (911) 2233-4455', templateSlug: 'tpl' });
      expect(mockCreate.mock.calls[0][0].to).toBe('whatsapp:+5491122334455');
    });

    it('retorna null para string vazia', async () => {
      const result = await service.sendWhatsApp({ to: '', templateSlug: 'tpl' });
      expect(result.isFailure).toBe(true);
    });
  });

  // ─── mapToContentVariables ────────────────────────────────────

  describe('mapToContentVariables', () => {
    it('mapeia variáveis na ordem de aparição no body', () => {
      const body = 'Hola {{name}}, tu cita es el {{date}} a las {{time}}';
      const vars = { name: 'Juan', date: '07/04', time: '10:00' };

      const result = service.mapToContentVariables(body, vars);

      expect(result).toEqual({ '1': 'Juan', '2': '07/04', '3': '10:00' });
    });

    it('ignora variáveis duplicadas no body', () => {
      const body = '{{name}} dijo {{name}}: tu cita es {{date}}';
      const vars = { name: 'Juan', date: '07/04' };

      const result = service.mapToContentVariables(body, vars);

      expect(result).toEqual({ '1': 'Juan', '2': '07/04' });
    });

    it('retorna string vazia para variável ausente', () => {
      const body = 'Hola {{name}}, {{missing_var}} aquí';
      const vars = { name: 'Juan' };

      const result = service.mapToContentVariables(body, vars);

      expect(result).toEqual({ '1': 'Juan', '2': '' });
    });

    it('retorna objeto vazio se body não tem placeholders', () => {
      const result = service.mapToContentVariables('Sin variables', {});

      expect(result).toEqual({});
    });

    it('mapeia 4 variáveis do template qualified_worker na ordem correta', () => {
      const body = '{{slot_1}}{{slot_2}}{{slot_3}}{{case_number}}';
      const vars = {
        slot_1: 'Lun 07/04 10:00',
        slot_2: 'Mar 08/04 15:00',
        slot_3: 'Mié 09/04 09:00',
        case_number: '42',
        job_posting_id: 'jp-123', // extra var (not in body) should be ignored
      };

      const result = service.mapToContentVariables(body, vars);

      expect(result).toEqual({
        '1': 'Lun 07/04 10:00',
        '2': 'Mar 08/04 15:00',
        '3': 'Mié 09/04 09:00',
        '4': '42',
      });
    });
  });

  // ─── Guard de tokens PII não-resolvidos ───────────────────────
  // Regressão de 2026-05-21: 167 workers receberam "Hola tk_<hash>" em vez do
  // nome porque o caller esqueceu de chamar TokenService.resolveVariables.
  describe('guardUnresolvedTokens', () => {
    it('sendWhatsApp REJEITA envio quando variables contém tk_ não resolvido', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValue({
        slug: 'talentum_incomplete_reminder',
        body: 'Hola {{worker_name}}',
        contentSid: 'HXabc',
      });

      const result = await service.sendWhatsApp({
        to: '+5491176614743',
        templateSlug: 'talentum_incomplete_reminder',
        variables: { worker_name: 'tk_1becdd3bd1fea388' },
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toMatch(/Unresolved PII tokens/);
      expect(result.error).toContain('worker_name=tk_1becdd3bd1fea388');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('sendWhatsApp ACEITA envio quando variables tem só valores plaintext', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValue({
        slug: 'talentum_incomplete_reminder',
        body: 'Hola {{worker_name}}',
        contentSid: 'HXabc',
      });
      mockCreate.mockResolvedValue({ sid: 'SMok', status: 'queued' });

      const result = await service.sendWhatsApp({
        to: '+5491176614743',
        templateSlug: 'talentum_incomplete_reminder',
        variables: { worker_name: 'João Silva' },
      });

      expect(result.isSuccess).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('sendWithContentSid REJEITA envio quando contentVariables contém tk_', async () => {
      const result = await service.sendWithContentSid(
        '+5491176614743',
        'HXabc',
        { '1': 'tk_abc123def456' },
      );

      expect(result.isFailure).toBe(true);
      expect(result.error).toMatch(/Unresolved PII tokens/);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('não bloqueia valores que apenas começam com letras parecidas (ex: "tkachenko")', async () => {
      mockTemplateRepo.findBySlug.mockResolvedValue({
        slug: 'talentum_incomplete_reminder',
        body: 'Hola {{worker_name}}',
        contentSid: 'HXabc',
      });
      mockCreate.mockResolvedValue({ sid: 'SMok', status: 'queued' });

      const result = await service.sendWhatsApp({
        to: '+5491176614743',
        templateSlug: 'talentum_incomplete_reminder',
        variables: { worker_name: 'Tkachenko' },
      });

      expect(result.isSuccess).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});
