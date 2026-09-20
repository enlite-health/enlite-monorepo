/**
 * O aviso à conta ABSORVIDA (D85) — e, principalmente, o que ele deixa
 * REGISTRADO quando não consegue avisar.
 *
 * Este arquivo estava com 0% de unit: o único exercício era o e2e do fluxo de
 * vínculo, que afirma o evento mas não o MOTIVO. E o motivo é o dado que
 * importa aqui: quem lê a trilha precisa saber se o SendGrid recusou o envio ou
 * se nem existia canal — as duas coisas caíam na mesma linha `send_failed`.
 *
 * A regra de fundo é a da casa: best-effort NUNCA é silencioso. Falha de e-mail
 * não desfaz o merge, mas tem que virar linha na trilha com o porquê certo.
 */

const mockSendAccountLinkedNotice = jest.fn();
const mockRecordEvent = jest.fn();
const mockReportError = jest.fn();

jest.mock('../../identity/infrastructure/EmailService', () => {
  class EmailChannelUnavailableError extends Error {
    constructor(public readonly motivo: string) {
      super(`[email] envio não realizado — ${motivo}`);
      this.name = 'EmailChannelUnavailableError';
    }
  }
  return {
    EmailChannelUnavailableError,
    EmailService: class {
      sendAccountLinkedNotice = (...args: unknown[]) => mockSendAccountLinkedNotice(...args);
    },
  };
});

jest.mock('../accountLinkEvents', () => ({
  recordAccountLinkEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

jest.mock('@shared/logging', () => ({
  logger: { child: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }) },
  reportError: (...args: unknown[]) => mockReportError(...args),
  loggingAls: { getStore: () => undefined },
}));

import { EmailChannelUnavailableError } from '../../identity/infrastructure/EmailService';
import { sendLinkedNoticeEmail } from '../accountLinkNotice';

const PARAMS = { survivorId: 'sobrevivente', absorbedId: 'absorvida', mergeAuditId: 42 };

function poolCom(email: string | null | undefined): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows: email === undefined ? [] : [{ email }] }) };
}

/** O `detail` da última linha gravada na trilha. */
function ultimoEvento(): Record<string, unknown> {
  return mockRecordEvent.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('sendLinkedNoticeEmail', () => {
  const ENV_ORIGINAL = process.env.ACCOUNT_LINK_PUBLIC_BASE_URL;
  const SEGREDO_ORIGINAL = process.env.ACCOUNT_LINK_TOKEN_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    // O `signLinkToken` é o de VERDADE (não mockado): assinar é parte do que
    // este fluxo entrega, e sem segredo ele lança — o que mandaria todos os
    // casos felizes para o `catch` sem ninguém perceber.
    process.env.ACCOUNT_LINK_TOKEN_SECRET = 'segredo-de-teste';
    mockSendAccountLinkedNotice.mockResolvedValue(undefined);
    mockRecordEvent.mockResolvedValue(undefined);
  });
  afterAll(() => {
    if (ENV_ORIGINAL === undefined) delete process.env.ACCOUNT_LINK_PUBLIC_BASE_URL;
    else process.env.ACCOUNT_LINK_PUBLIC_BASE_URL = ENV_ORIGINAL;
    if (SEGREDO_ORIGINAL === undefined) delete process.env.ACCOUNT_LINK_TOKEN_SECRET;
    else process.env.ACCOUNT_LINK_TOKEN_SECRET = SEGREDO_ORIGINAL;
  });

  it('sem ACCOUNT_LINK_TOKEN_SECRET, o aviso não sai e o skip fica registrado', async () => {
    delete process.env.ACCOUNT_LINK_TOKEN_SECRET;

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    expect(mockSendAccountLinkedNotice).not.toHaveBeenCalled();
    expect(ultimoEvento()).toMatchObject({ detail: { reason: 'send_failed' } });
  });

  it('envia o aviso com link de undo assinado e registra `notice_email_sent`', async () => {
    process.env.ACCOUNT_LINK_PUBLIC_BASE_URL = 'https://api.exemplo.test';

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    const [destinatario, { undoUrl }] = mockSendAccountLinkedNotice.mock.calls[0] as [string, { undoUrl: string }];
    expect(destinatario).toBe('pessoa@exemplo.com');
    expect(undoUrl.startsWith('https://api.exemplo.test/api/account-link/undo/')).toBe(true);
    expect(ultimoEvento()).toMatchObject({ event: 'notice_email_sent', mergeAuditId: 42 });
  });

  it('sem base configurada, o link cai no domínio de produção', async () => {
    delete process.env.ACCOUNT_LINK_PUBLIC_BASE_URL;

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    const [, { undoUrl }] = mockSendAccountLinkedNotice.mock.calls[0] as [string, { undoUrl: string }];
    expect(undoUrl.startsWith('https://api.enlite.health/api/account-link/undo/')).toBe(true);
  });

  // Não há a quem avisar: e-mail ausente, ou sintético do import em massa.
  it.each([
    ['sem e-mail', null],
    ['linha inexistente', undefined],
    ['e-mail sintético do import', 'alguem@enlite.import'],
    ['sintético em caixa alta', 'ALGUEM@ENLITE.IMPORT'],
  ])('%s → registra `no_real_email` e nem tenta enviar', async (_nome, email) => {
    await sendLinkedNoticeEmail(poolCom(email as string | null) as never, PARAMS);

    expect(mockSendAccountLinkedNotice).not.toHaveBeenCalled();
    expect(ultimoEvento()).toMatchObject({
      event: 'notice_email_skipped',
      detail: { reason: 'no_real_email' },
    });
  });

  it('SendGrid recusou → `send_failed` E vai para o Error Reporting', async () => {
    mockSendAccountLinkedNotice.mockRejectedValue(new Error('401 Unauthorized'));

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    expect(ultimoEvento()).toMatchObject({
      event: 'notice_email_skipped',
      detail: { reason: 'send_failed' },
    });
    expect(mockReportError).toHaveBeenCalled();
  });

  // O ponto do arquivo: canal ausente NÃO é erro do SendGrid, e a trilha
  // precisa dizer isso — senão quem lê não sabe se houve recusa ou se não
  // havia canal nenhum.
  it('canal ausente → `no_email_channel` e NÃO polui o Error Reporting', async () => {
    mockSendAccountLinkedNotice.mockRejectedValue(new EmailChannelUnavailableError('ambiente de teste'));

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    expect(ultimoEvento()).toMatchObject({
      event: 'notice_email_skipped',
      detail: { reason: 'no_email_channel' },
    });
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('rejeição que não é Error vira Error antes de virar linha', async () => {
    mockSendAccountLinkedNotice.mockRejectedValue('caiu a rede');

    await sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS);

    expect(ultimoEvento()).toMatchObject({ detail: { reason: 'send_failed' } });
    expect(mockReportError).toHaveBeenCalled();
  });

  it('falha de e-mail NUNCA propaga — o merge não pode ser desfeito por isso', async () => {
    mockSendAccountLinkedNotice.mockRejectedValue(new Error('qualquer'));

    await expect(
      sendLinkedNoticeEmail(poolCom('pessoa@exemplo.com') as never, PARAMS),
    ).resolves.toBeUndefined();
  });
});
