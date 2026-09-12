/**
 * PeriskopeNoteService.test.ts
 *
 * Foco: PII guard (achado do gate 11/09, ponto 9) — `mirrorAsNote` nunca loga o
 * telefone cru nem `message`/`stack` do erro quando o POST falha (best-effort).
 * Não cobre o restante do fluxo (auto-discovery de org_id, chat_id) — fora do
 * escopo deste conserto.
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
    // NOTA: mockado — este teste NÃO cobre o que `reportError` de fato envia ao Cloud
    // Error Reporting (message/stack crus do erro, PR separado, ver comentário na
    // linha do `reportError(e, ...)` em PeriskopeNoteService.ts).
    reportError: jest.fn(),
    safeErrorFields: actual.safeErrorFields,
  };
});

import { PeriskopeNoteService } from '../PeriskopeNoteService';

describe('PeriskopeNoteService', () => {
  const ORIGINAL_ENV = process.env;
  const SENSITIVE_PHONE = '+5491122334455';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, PERISKOPE_API_KEY: 'test-key', PERISKOPE_PHONE: '5491100000000', PERISKOPE_NOTE_AUTHOR: 'recrutadora@enlite.health', PERISKOPE_ORG_ID: 'org-1' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('não configurado → retorna false sem lançar', async () => {
    delete process.env.PERISKOPE_NOTE_AUTHOR;
    const service = new PeriskopeNoteService();
    await expect(service.mirrorAsNote(SENSITIVE_PHONE, 'mensagem')).resolves.toBe(false);
  });

  it('configurado, POST bem-sucedido → true', async () => {
    const mockPost = jest.fn().mockResolvedValue({ data: {} });
    mockedAxios.create.mockReturnValue({ post: mockPost, get: jest.fn() } as any);

    const service = new PeriskopeNoteService();
    await expect(service.mirrorAsNote(SENSITIVE_PHONE, 'mensagem')).resolves.toBe(true);
  });

  // ── PII guard (ponto 9) ──────────────────────────────────────────────────────
  it('PII: telefone mascarado e nunca message/stack no log de falha', async () => {
    const sensitiveMessage = `timeout contacting chat for ${SENSITIVE_PHONE.replace('+', '')}@c.us`;
    const mockPost = jest.fn().mockRejectedValue(Object.assign(new Error(sensitiveMessage), { code: 'ETIMEDOUT' }));
    mockedAxios.create.mockReturnValue({ post: mockPost, get: jest.fn() } as any);

    const service = new PeriskopeNoteService();
    const result = await service.mirrorAsNote(SENSITIVE_PHONE, 'mensagem');

    expect(result).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockLoggerWarn.mock.calls[0] as [Record<string, unknown>, string];

    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_PHONE.replace('+', ''));
    expect(payload.workerPhone).toBe('+549******4455');
    expect(payload).not.toHaveProperty('message');
    expect(payload).not.toHaveProperty('stack');
    expect(payload).toEqual(expect.objectContaining({ errorName: 'Error', code: 'ETIMEDOUT' }));
    expect(JSON.stringify(payload)).not.toContain(sensitiveMessage);
  });

  it('sabotagem: reproduzindo o log ANTIGO (telefone + message crus), a asserção acima cairia', async () => {
    // Comportamento ANTIGO simulado diretamente.
    mockLoggerWarn({ error: 'Periskope 500', workerPhone: SENSITIVE_PHONE }, '[PeriskopeNoteService] mirrorAsNote failed (best-effort)');
    const oldPayload = mockLoggerWarn.mock.calls[0][0] as Record<string, unknown>;
    expect(oldPayload.workerPhone).toBe(SENSITIVE_PHONE);
    mockLoggerWarn.mockClear();

    // Código ATUAL: não vaza.
    const mockPost = jest.fn().mockRejectedValue(new Error('Periskope 500'));
    mockedAxios.create.mockReturnValue({ post: mockPost, get: jest.fn() } as any);
    const service = new PeriskopeNoteService();
    await service.mirrorAsNote(SENSITIVE_PHONE, 'mensagem');

    const [newPayload] = mockLoggerWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(newPayload.workerPhone).not.toBe(SENSITIVE_PHONE);
    expect(newPayload.workerPhone).toBe('+549******4455');
  });
});
