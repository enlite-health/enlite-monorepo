/**
 * PeriskopeTicketService.test.ts
 *
 * Cenários:
 * 1. não configurado (sem PERISKOPE_API_KEY/PERISKOPE_PHONE) → retorna false, não lança
 * 2. configurado, POST bem-sucedido → true, payload correto (chat_id @c.us, subject)
 * 3. opts.assignee/labels repassados no body quando presentes
 * 4. POST falha (HTTP erro) → best-effort: retorna false, não lança
 * 5. opts.priority repassado no body; ausente → campo NÃO vai no payload
 */
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockLoggerWarn = jest.fn();

jest.mock('@shared/logging', () => {
  const actual = jest.requireActual('@shared/logging');
  return {
    logger: {
      child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
      info: jest.fn(),
      warn: (...args: unknown[]) => mockLoggerWarn(...args),
      error: jest.fn(),
    },
    reportError: jest.fn(),
    // Funções puras — usar a implementação REAL prova o comportamento de verdade,
    // não um dublê que sempre concorda com o que o produção manda.
    safeErrorFields: actual.safeErrorFields,
  };
});

import { PeriskopeTicketService } from '../PeriskopeTicketService';

describe('PeriskopeTicketService', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('não configurado → retorna false sem lançar', async () => {
    delete process.env.PERISKOPE_API_KEY;
    delete process.env.PERISKOPE_PHONE;

    const service = new PeriskopeTicketService();
    const result = await service.createTicket('+5491122334455', 'Handover worker x');

    expect(result).toBe(false);
  });

  it('configurado, POST bem-sucedido → true, payload correto', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';

    const mockPost = jest.fn().mockResolvedValue({ data: { id: 'ticket-1' } });
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    const result = await service.createTicket('+5491122334455', 'Handover worker x');

    expect(result).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/tickets/create', {
      chat_id: '5491122334455@c.us',
      subject: 'Handover worker x',
    });
  });

  it('opts.assignee/labels repassados no body quando presentes', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';

    const mockPost = jest.fn().mockResolvedValue({ data: { id: 'ticket-2' } });
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    await service.createTicket('+5491122334455', 'Handover worker y', {
      assignee: 'recrutadora@enlite.health',
      labels: 'handover,urgente',
    });

    expect(mockPost).toHaveBeenCalledWith('/tickets/create', {
      chat_id: '5491122334455@c.us',
      subject: 'Handover worker y',
      assignee: 'recrutadora@enlite.health',
      labels: 'handover,urgente',
    });
  });

  it('POST falha → best-effort: retorna false, não lança', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';

    const mockPost = jest.fn().mockRejectedValue(new Error('Periskope 500'));
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    const result = await service.createTicket('+5491122334455', 'Handover worker z');

    expect(result).toBe(false);
  });
  it('priority repassada no body quando presente', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';
    const mockPost = jest.fn().mockResolvedValue({ data: {} });
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    await service.createTicket('+5491122334455', 'asunto', { priority: '4' });

    expect(mockPost.mock.calls[0][1]).toMatchObject({ priority: '4' });
  });

  it('sem priority → o campo NÃO vai no payload (não sobrescreve default da API)', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';
    const mockPost = jest.fn().mockResolvedValue({ data: {} });
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    await service.createTicket('+5491122334455', 'asunto');

    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('priority');
  });
  it('rejeição que NÃO é Error também é best-effort (branch do catch)', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';
    const mockPost = jest.fn().mockRejectedValue('boom sem stack');
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    await expect(
      service.createTicket('+5491122334455', 'asunto'),
    ).resolves.toBe(false);
  });

  // ── PII guard (ponto 8 do achado 11/09) ─────────────────────────────────────
  // O erro do axios pode carregar a URL/corpo da request COM o telefone; nunca deve
  // sair cru — nem o telefone, nem `message`/`stack` do erro.
  it('PII: telefone mascarado e error SEM message/stack no log de falha', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';
    const SENSITIVE_PHONE = '+5491122334455';
    const sensitiveMessage = `Request failed for chat ${SENSITIVE_PHONE.replace('+', '')}@c.us`;
    const mockPost = jest.fn().mockRejectedValue(Object.assign(new Error(sensitiveMessage), { code: 'ETIMEDOUT' }));
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);

    const service = new PeriskopeTicketService();
    const result = await service.createTicket(SENSITIVE_PHONE, 'asunto');

    expect(result).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockLoggerWarn.mock.calls[0] as [Record<string, unknown>, string];

    // O telefone cru nunca aparece — só os últimos 4 dígitos.
    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_PHONE.replace('+', ''));
    expect(payload.chatPhone).toBe('+549******4455');
    // Nem message nem stack do erro — só errorName + SQLSTATE/código.
    expect(payload).not.toHaveProperty('message');
    expect(payload).not.toHaveProperty('stack');
    expect(payload).toEqual(expect.objectContaining({ errorName: 'Error', code: 'ETIMEDOUT' }));
    expect(JSON.stringify(payload)).not.toContain(sensitiveMessage);
  });

  // Sabotagem: restaura em CÓPIA o comportamento ANTIGO (log cru de phone/message) —
  // se alguém desfizer o fix, este teste morre. Restaurar (código atual) → passa.
  it('sabotagem: se o log voltasse a expor chatPhone/message crus, este teste cairia', async () => {
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491100000000';
    const SENSITIVE_PHONE = '+5491122334455';

    // Simula o comportamento ANTIGO diretamente — prova que a asserção abaixo É
    // capaz de pegar o vazamento (não é uma asserção morta).
    mockLoggerWarn({ error: 'Periskope 500', chatPhone: SENSITIVE_PHONE }, '[PeriskopeTicketService] createTicket failed (best-effort)');
    const oldPayload = mockLoggerWarn.mock.calls[0][0] as Record<string, unknown>;
    expect(oldPayload.chatPhone).toBe(SENSITIVE_PHONE); // comportamento antigo vazava — confirmado
    mockLoggerWarn.mockClear();

    // Código ATUAL: não vaza.
    const mockPost = jest.fn().mockRejectedValue(new Error('Periskope 500'));
    mockedAxios.create.mockReturnValue({ post: mockPost } as any);
    const service = new PeriskopeTicketService();
    await service.createTicket(SENSITIVE_PHONE, 'asunto');

    const [newPayload] = mockLoggerWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(newPayload.chatPhone).not.toBe(SENSITIVE_PHONE);
    expect(newPayload.chatPhone).toBe('+549******4455');
  });
});
