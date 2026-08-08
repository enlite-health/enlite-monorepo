import type { AxiosInstance } from 'axios';
import { PeriskopeChatReadService } from '../PeriskopeChatReadService';

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger, reportError } = require('@shared/logging');

function httpWith(get: jest.Mock): AxiosInstance {
  return { get } as unknown as AxiosInstance;
}

describe('PeriskopeChatReadService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('configuração', () => {
    it('sem cliente HTTP: não configurado e listGroupChats devolve null', async () => {
      const svc = new PeriskopeChatReadService(null);
      expect(svc.isConfigured).toBe(false);
      expect(await svc.listGroupChats()).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('com cliente HTTP: configurado', () => {
      expect(new PeriskopeChatReadService(httpWith(jest.fn())).isConfigured).toBe(true);
    });

    it('sem argumento cai na fábrica de env (sem credencial → não configurado)', () => {
      const oldKey = process.env.PERISKOPE_API_KEY;
      const oldPhone = process.env.PERISKOPE_PHONE;
      delete process.env.PERISKOPE_API_KEY;
      delete process.env.PERISKOPE_PHONE;
      expect(new PeriskopeChatReadService().isConfigured).toBe(false);
      if (oldKey) process.env.PERISKOPE_API_KEY = oldKey;
      if (oldPhone) process.env.PERISKOPE_PHONE = oldPhone;
    });
  });

  describe('listGroupChats', () => {
    it('chama GET /chats filtrando por grupo e mapeia o payload', async () => {
      const get = jest.fn().mockResolvedValue({
        data: {
          chats: [
            { chat_id: '120363001234567890@g.us', chat_name: 'Flia Perez', member_count: 12 },
            { chat_id: '5491112345678-1600000000@g.us', chat_name: null, member_count: null },
          ],
        },
      });

      const out = await new PeriskopeChatReadService(httpWith(get)).listGroupChats();

      expect(get).toHaveBeenCalledWith('/chats', { params: { chat_type: 'group', limit: 1000 } });
      expect(out).toEqual([
        { chatId: '120363001234567890@g.us', chatName: 'Flia Perez', memberCount: 12 },
        { chatId: '5491112345678-1600000000@g.us', chatName: null, memberCount: null },
      ]);
    });

    it('descarta qualquer coisa que não seja @g.us — 1-1 nunca vira candidato', async () => {
      const get = jest.fn().mockResolvedValue({
        data: {
          chats: [
            { chat_id: '5491162180721@c.us', chat_name: 'Juan' },
            { chat_id: '120363001234567890@g.us', chat_name: 'Flia Perez' },
            { chat_name: 'sem chat_id' },
            { chat_id: 42 },
          ],
        },
      });

      const out = await new PeriskopeChatReadService(httpWith(get)).listGroupChats();
      expect(out).toEqual([
        { chatId: '120363001234567890@g.us', chatName: 'Flia Perez', memberCount: null },
      ]);
    });

    it('payload sem `chats` devolve lista vazia (não null)', async () => {
      const get = jest.fn().mockResolvedValue({ data: {} });
      expect(await new PeriskopeChatReadService(httpWith(get)).listGroupChats()).toEqual([]);
    });

    it('resposta sem body devolve lista vazia', async () => {
      const get = jest.fn().mockResolvedValue({});
      expect(await new PeriskopeChatReadService(httpWith(get)).listGroupChats()).toEqual([]);
    });

    it('avisa quando a lista bate no teto (possível truncamento)', async () => {
      const chats = Array.from({ length: 1000 }, (_, i) => ({
        chat_id: `12036300000000${String(i).padStart(4, '0')}@g.us`,
        chat_name: `G${i}`,
      }));
      const get = jest.fn().mockResolvedValue({ data: { chats } });

      const out = await new PeriskopeChatReadService(httpWith(get)).listGroupChats();

      expect(out).toHaveLength(1000);
      expect(logger.warn).toHaveBeenCalledWith(
        { returned: 1000, limit: 1000 },
        expect.stringContaining('truncada'),
      );
    });

    it('erro HTTP vira null (best-effort) e é reportado', async () => {
      const get = jest.fn().mockRejectedValue(new Error('boom'));
      expect(await new PeriskopeChatReadService(httpWith(get)).listGroupChats()).toBeNull();
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        { source: 'PeriskopeChatReadService:listGroupChats' },
      );
    });

    it('rejeição não-Error também vira null', async () => {
      const get = jest.fn().mockRejectedValue('string solta');
      expect(await new PeriskopeChatReadService(httpWith(get)).listGroupChats()).toBeNull();
    });

    it('NUNCA loga nome de grupo (PII) — só contagens', async () => {
      const get = jest.fn().mockResolvedValue({
        data: { chats: [{ chat_id: '120363001234567890@g.us', chat_name: 'Flia Perez' }] },
      });
      await new PeriskopeChatReadService(httpWith(get)).listGroupChats();
      const logged = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(reportError.mock.calls);
      expect(logged).not.toContain('Perez');
    });

    it('o serviço não expõe nenhum caminho de escrita', () => {
      const svc = new PeriskopeChatReadService(httpWith(jest.fn())) as unknown as Record<string, unknown>;
      const surface = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(svc)),
        ...Object.keys(svc),
      ];
      expect(surface).not.toContain('send');
      expect(surface).not.toContain('sendToGroup');
      expect(surface).not.toContain('post');
      expect(surface.filter(k => k !== 'constructor').sort()).toEqual(['http', 'isConfigured', 'listGroupChats']);
    });
  });
});
