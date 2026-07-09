/**
 * PeriskopeTicketService.test.ts
 *
 * Cenários:
 * 1. não configurado (sem PERISKOPE_API_KEY/PERISKOPE_PHONE) → retorna false, não lança
 * 2. configurado, POST bem-sucedido → true, payload correto (chat_id @c.us, subject)
 * 3. opts.assignee/labels repassados no body quando presentes
 * 4. POST falha (HTTP erro) → best-effort: retorna false, não lança
 */
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
}));

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
});
