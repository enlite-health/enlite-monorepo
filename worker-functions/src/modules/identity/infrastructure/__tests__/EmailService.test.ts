/**
 * EmailService.test.ts
 *
 * Unit tests for the SendGrid-backed transactional email service.
 *
 * Scenarios:
 * 1. sendInvitationEmail — calls sgMail.send with correct to/from/subject
 * 2. sendInvitationEmail — HTML contains the invite link + CTA
 * 3. sendInvitationEmail — HTML contains the recipient's name
 * 4. sendPasswordResetEmail — calls sgMail.send with correct to/from/subject
 * 5. sendPasswordResetEmail — HTML contains the reset link + CTA
 * 6. EMAIL_FROM env var is respected
 * 7. EMAIL_FROM falls back to enlite@enlite.health when unset
 * 8. SENDGRID_API_KEY is passed to sgMail.setApiKey on construction
 * 9. Propagates SendGrid errors (caller decides how to handle)
 *
 * ⚠️ GUARD DE ENVIO (17/08/2026): o serviço agora RECUSA enviar quando
 * `NODE_ENV=test` ou quando falta `SENDGRID_API_KEY` — achado em revisão, com
 * requisição real medida saindo do e2e para `api.sendgrid.com`. Como o jest
 * roda com `NODE_ENV=test`, os casos que exercitam o ENVIO precisam declarar
 * explicitamente que não estão em teste (`envDeProducao()`); os dois casos no
 * fim do arquivo provam o guard em si. Sem essa distinção o arquivo estaria
 * testando o guard sem querer, e ninguém veria o HTML de novo.
 */

const mockSend = jest.fn();
const mockSetApiKey = jest.fn();

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: {
    send: (...args: unknown[]) => mockSend(...args),
    setApiKey: (...args: unknown[]) => mockSetApiKey(...args),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

import { EmailChannelUnavailableError, EmailService } from '../EmailService';

const NODE_ENV_ORIGINAL = process.env.NODE_ENV;

/**
 * O jest roda com `NODE_ENV=test` e o guard recusa envio nesse ambiente. Quem
 * quer exercitar o ENVIO precisa dizer que não é teste — e o par com chave
 * presente é o estado de produção.
 */
function envDeProducao(): void {
  process.env.NODE_ENV = 'production';
  process.env.SENDGRID_API_KEY = 'SG.test-key';
}

describe('EmailService', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSetApiKey.mockReset();
    mockSend.mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': 'msg-test' } }]);
    delete process.env.EMAIL_FROM;
    delete process.env.SENDGRID_API_KEY;
    envDeProducao();
  });

  afterAll(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
  });

  describe('construction', () => {
    it('calls sgMail.setApiKey when SENDGRID_API_KEY is set', () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      new EmailService();
      expect(mockSetApiKey).toHaveBeenCalledWith('SG.test-key');
    });

    it('does NOT call sgMail.setApiKey when SENDGRID_API_KEY is unset', () => {
      delete process.env.SENDGRID_API_KEY;
      delete process.env.SENDGRID_API_KEY;
      new EmailService();
      expect(mockSetApiKey).not.toHaveBeenCalled();
    });
  });

  describe('sendInvitationEmail', () => {
    it('calls sgMail.send with correct to/from/subject', async () => {
      process.env.EMAIL_FROM = 'custom-from@enlite.health';
      const service = new EmailService();
      await service.sendInvitationEmail('new-admin@enlite.health', 'Ana', 'https://firebase.link/abc');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.to).toBe('new-admin@enlite.health');
      expect(call.from).toEqual({ email: 'custom-from@enlite.health', name: 'Enlite' });
      expect(call.subject).toBe('Fuiste invitado a Enlite — Definí tu contraseña');
    });

    it('HTML contains invite link and CTA button', async () => {
      const service = new EmailService();
      await service.sendInvitationEmail('x@test.com', 'Ana', 'https://firebase.link/invite-xyz');

      const html = mockSend.mock.calls[0][0].html as string;
      expect(html).toContain('https://firebase.link/invite-xyz');
      expect(html).toContain('Definir contraseña');
    });

    it('HTML contains recipient name', async () => {
      const service = new EmailService();
      await service.sendInvitationEmail('x@test.com', 'Juan Pérez', 'https://link');

      const html = mockSend.mock.calls[0][0].html as string;
      expect(html).toContain('Juan Pérez');
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('calls sgMail.send with correct to/from/subject', async () => {
      const service = new EmailService();
      await service.sendPasswordResetEmail('admin@enlite.health', 'Carlos', 'https://firebase.link/reset');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.to).toBe('admin@enlite.health');
      expect(call.from).toEqual({ email: 'enlite@enlite.health', name: 'Enlite' });
      expect(call.subject).toBe('Restablecimiento de contraseña - Enlite');
    });

    it('HTML contains reset link and CTA button', async () => {
      const service = new EmailService();
      await service.sendPasswordResetEmail('x@test.com', 'Carlos', 'https://firebase.link/reset-abc');

      const html = mockSend.mock.calls[0][0].html as string;
      expect(html).toContain('https://firebase.link/reset-abc');
      expect(html).toContain('Restablecer contraseña');
    });
  });

  describe('EMAIL_FROM fallback', () => {
    it('uses enlite@enlite.health when EMAIL_FROM is not set', async () => {
      delete process.env.EMAIL_FROM;
      const service = new EmailService();
      await service.sendInvitationEmail('x@test.com', 'Ana', 'https://link');

      expect(mockSend.mock.calls[0][0].from).toEqual({
        email: 'enlite@enlite.health',
        name: 'Enlite',
      });
    });
  });

  describe('error propagation', () => {
    it('throws when SendGrid rejects', async () => {
      mockSend.mockRejectedValueOnce(new Error('401 Unauthorized'));
      const service = new EmailService();

      await expect(
        service.sendInvitationEmail('x@test.com', 'Ana', 'https://link'),
      ).rejects.toThrow('401 Unauthorized');
    });
  });
});

describe('EmailService — guard de envio (teste nunca toca canal real)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue([{ statusCode: 202, headers: {} }]);
  });
  afterAll(() => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
  });

  it('em NODE_ENV=test NÃO chama o SDK — nem com a chave presente', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SENDGRID_API_KEY = 'SG.chave-de-verdade-exportada-no-shell';

    await expect(
      new EmailService().sendInvitationEmail('alguem@enlite.health', 'Ana', 'https://x/y'),
    ).rejects.toThrow(EmailChannelUnavailableError);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sem SENDGRID_API_KEY NÃO chama o SDK (ele tentaria assim mesmo)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SENDGRID_API_KEY;

    await expect(
      new EmailService().sendAccountLinkedNotice('alguem@enlite.health', { undoUrl: 'https://x/undo' }),
    ).rejects.toMatchObject({ motivo: 'sem SENDGRID_API_KEY' });

    expect(mockSend).not.toHaveBeenCalled();
  });

  // A propriedade que importa para a TRILHA: quem chama distingue "não havia
  // canal" de "o SendGrid recusou", e registra o skip nos dois casos.
  it('o erro é TIPADO — a trilha não confunde canal ausente com falha do SendGrid', async () => {
    process.env.NODE_ENV = 'test';
    await expect(
      new EmailService().sendAccountLinkedNotice('alguem@enlite.health', { undoUrl: 'https://x' }),
    ).rejects.toBeInstanceOf(EmailChannelUnavailableError);
  });
});
