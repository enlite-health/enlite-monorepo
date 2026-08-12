/**
 * PeriskopeMessagingService.test.ts
 *
 * Testa o envio de mensagens WhatsApp via Periskope (WhatsApp Web gerenciado).
 *
 * Cenários:
 * 1. sendWhatsApp — envia body interpolado como texto livre
 * 2. sendWhatsApp — converte E.164 para chat_id <digitos>@c.us
 * 3. sendWhatsApp — renderiza botões como opções numeradas
 * 4. sendWhatsApp — retorna fail se serviço não configurado
 * 5. sendWhatsApp — retorna fail se número inválido
 * 6. sendWhatsApp — retorna fail se template não encontrado
 * 7. sendWhatsApp — retorna fail em erro da API Periskope
 * 8. sendWhatsApp — bloqueia variáveis com tokens PII não resolvidos
 * 9. sendWithContentSid — sempre fail (conceito Twilio, sem equivalente)
 * 10. renderMessage — sem botões retorna só o body interpolado
 */

import { PeriskopeMessagingService } from '../PeriskopeMessagingService';

const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({ post: mockPost })),
  },
}));

describe('PeriskopeMessagingService', () => {
  let service: PeriskopeMessagingService;
  let mockTemplateRepo: { findBySlug: jest.Mock };

  const queuedResponse = {
    data: { status: 'queued', unique_id: 'uid-123', queue_id: 'q-1' },
  };

  beforeEach(() => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';

    mockTemplateRepo = { findBySlug: jest.fn() };
    service = new PeriskopeMessagingService(mockTemplateRepo as any);
    mockPost.mockReset();
  });

  afterEach(() => {
    delete process.env.PERISKOPE_API_KEY;
    delete process.env.PERISKOPE_PHONE;
    jest.clearAllMocks();
  });

  // ─── sendWhatsApp ─────────────────────────────────────────────

  it('envia body interpolado como texto livre', async () => {
    mockTemplateRepo.findBySlug.mockResolvedValue({
      slug: 'welcome',
      body: 'Hola {{name}}!',
      buttons: null,
    });
    mockPost.mockResolvedValue(queuedResponse);

    const result = await service.sendWhatsApp({
      to: '+5491112345678',
      templateSlug: 'welcome',
      variables: { name: 'Maria' },
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual({ externalId: 'uid-123', status: 'queued', to: '+5491112345678' });
    expect(mockPost).toHaveBeenCalledWith('/message/send', {
      chat_id: '5491112345678@c.us',
      message: 'Hola Maria!',
    });
  });

  it('normaliza número argentino de 10 dígitos para chat_id com DDI 54', async () => {
    mockTemplateRepo.findBySlug.mockResolvedValue({ slug: 'welcome', body: 'Hola!', buttons: null });
    mockPost.mockResolvedValue(queuedResponse);

    const result = await service.sendWhatsApp({ to: '1112345678', templateSlug: 'welcome' });

    expect(result.isSuccess).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/message/send', expect.objectContaining({
      chat_id: '541112345678@c.us',
    }));
  });

  it('renderiza botões como opções numeradas', async () => {
    mockTemplateRepo.findBySlug.mockResolvedValue({
      slug: 'reminder',
      body: '¿Vas a participar?',
      buttons: [
        { id: 'confirm_yes', label: 'Sí' },
        { id: 'confirm_no', label: 'No' },
      ],
    });
    mockPost.mockResolvedValue(queuedResponse);

    await service.sendWhatsApp({ to: '+5491112345678', templateSlug: 'reminder' });

    const sent = mockPost.mock.calls[0][1].message as string;
    expect(sent).toContain('¿Vas a participar?');
    expect(sent).toContain('*1.* Sí');
    expect(sent).toContain('*2.* No');
    expect(sent).toContain('Respondé con el número');
  });

  it('retorna fail se serviço não configurado', async () => {
    delete process.env.PERISKOPE_API_KEY;
    const unconfigured = new PeriskopeMessagingService(mockTemplateRepo as any);

    const result = await unconfigured.sendWhatsApp({ to: '+5491112345678', templateSlug: 'welcome' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('not configured');
  });

  it('retorna fail se número inválido', async () => {
    const result = await service.sendWhatsApp({ to: 'abc', templateSlug: 'welcome' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('Invalid phone number');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('retorna fail se template não encontrado', async () => {
    mockTemplateRepo.findBySlug.mockResolvedValue(null);

    const result = await service.sendWhatsApp({ to: '+5491112345678', templateSlug: 'missing' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain("'missing'");
  });

  it('retorna fail em erro da API Periskope', async () => {
    mockTemplateRepo.findBySlug.mockResolvedValue({ slug: 'welcome', body: 'Hola!', buttons: null });
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed'), {
      response: { data: { error: 'rate limited' } },
    }));

    const result = await service.sendWhatsApp({ to: '+5491112345678', templateSlug: 'welcome' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('Periskope error');
    expect(result.error).toContain('rate limited');
  });

  it('bloqueia variáveis com tokens PII não resolvidos', async () => {
    const result = await service.sendWhatsApp({
      to: '+5491112345678',
      templateSlug: 'welcome',
      variables: { name: 'tk_1becdd3bd1fea388' },
    });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('Unresolved PII tokens');
    expect(mockPost).not.toHaveBeenCalled();
  });

  // ─── sendWithContentSid ───────────────────────────────────────

  it('sendWithContentSid sempre falha (conceito Twilio)', async () => {
    const result = await service.sendWithContentSid('+5491112345678', 'HX123', { '1': 'x' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('does not support Twilio Content API');
    expect(mockPost).not.toHaveBeenCalled();
  });

  // ─── renderMessage ────────────────────────────────────────────

  it('renderMessage sem botões retorna só o body interpolado', () => {
    const rendered = service.renderMessage(
      { slug: 'x', body: 'Hola {{name}}!', buttons: null } as any,
      { name: 'Maria' },
    );
    expect(rendered).toBe('Hola Maria!');
  });
});
