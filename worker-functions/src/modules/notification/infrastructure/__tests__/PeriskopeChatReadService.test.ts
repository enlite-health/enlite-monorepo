import type { AxiosInstance } from 'axios';
import { PeriskopeChatReadService } from '../PeriskopeChatReadService';

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger, reportError } = require('@shared/logging');

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

function httpWith(get: jest.Mock): AxiosInstance {
  return { get } as unknown as AxiosInstance;
}

/** N grupos válidos, com chat_id determinístico e distinto. */
function groups(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    chat_id: `1203630000000${String(offset + i).padStart(5, '0')}@g.us`,
    chat_name: `G${offset + i}`,
    member_count: 5,
  }));
}

/** `get` que devolve páginas na ordem em que foram pedidas. */
function pagedGet(pages: Array<ReturnType<typeof groups>>): jest.Mock {
  return jest.fn().mockImplementation((_url: string, cfg: { params: { offset: number } }) => {
    const page = pages[cfg.params.offset / PAGE_SIZE] ?? [];
    return Promise.resolve({ data: { chats: page } });
  });
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

    it('TTL do cache vem de PERISKOPE_CHATS_CACHE_TTL_MS; valor inválido cai no default', async () => {
      const old = process.env.PERISKOPE_CHATS_CACHE_TTL_MS;

      // TTL 0 pelo env = cache desligado: a 2ª chamada varre de novo.
      process.env.PERISKOPE_CHATS_CACHE_TTL_MS = '0';
      const semCache = pagedGet([groups(3)]);
      const a = new PeriskopeChatReadService(httpWith(semCache));
      await a.listGroupChats();
      await a.listGroupChats();
      expect(semCache).toHaveBeenCalledTimes(2);

      // Valor inválido → default (cacheia): a 2ª chamada não varre.
      process.env.PERISKOPE_CHATS_CACHE_TTL_MS = 'não-é-número';
      const comCache = pagedGet([groups(3)]);
      const b = new PeriskopeChatReadService(httpWith(comCache));
      await b.listGroupChats();
      await b.listGroupChats();
      expect(comCache).toHaveBeenCalledTimes(1);

      if (old === undefined) delete process.env.PERISKOPE_CHATS_CACHE_TTL_MS;
      else process.env.PERISKOPE_CHATS_CACHE_TTL_MS = old;
    });
  });

  describe('listGroupChats — paginação', () => {
    it('página incompleta na primeira volta: 1 chamada, lista completa', async () => {
      const get = pagedGet([groups(2)]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('/chats', {
        params: { chat_type: 'group', limit: PAGE_SIZE, offset: 0 },
      });
      expect(out).toEqual({
        groups: [
          { chatId: '120363000000000000@g.us', chatName: 'G0', memberCount: 5, orgPhone: null },
          { chatId: '120363000000000001@g.us', chatName: 'G1', memberCount: 5, orgPhone: null },
        ],
        truncated: false,
      });
    });

    it('varre TODAS as páginas: 200 + 200 + 74 = 474 grupos, 3 chamadas com offset crescente', async () => {
      const get = pagedGet([groups(PAGE_SIZE, 0), groups(PAGE_SIZE, 200), groups(74, 400)]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(get).toHaveBeenCalledTimes(3);
      expect(get.mock.calls.map(c => c[1].params.offset)).toEqual([0, 200, 400]);
      expect(out?.groups).toHaveLength(474);
      expect(out?.truncated).toBe(false);
    });

    it('a lista da org de hoje (774) cabe inteira — nenhum paciente fica fora do alcance', async () => {
      const get = pagedGet([
        groups(PAGE_SIZE, 0),
        groups(PAGE_SIZE, 200),
        groups(PAGE_SIZE, 400),
        groups(174, 600),
      ]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(out?.groups).toHaveLength(774);
      expect(out?.truncated).toBe(false);
      // O grupo 773 é o último da última página: com o teto antigo de 1.000 numa
      // única chamada, o crescimento da org o deixaria invisível na busca.
      expect(out?.groups.at(-1)?.chatId).toBe('120363000000000773@g.us');
    });

    it('página cheia seguida de página vazia encerra sem truncar', async () => {
      const get = pagedGet([groups(PAGE_SIZE, 0), []]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(get).toHaveBeenCalledTimes(2);
      expect(out?.groups).toHaveLength(PAGE_SIZE);
      expect(out?.truncated).toBe(false);
    });

    it('chat_id repetido entre páginas entra uma vez só', async () => {
      const repetido = { chat_id: '120363000000099999@g.us', chat_name: 'G', member_count: 1 };
      const get = pagedGet([
        [...groups(PAGE_SIZE - 1, 0), repetido],
        [repetido, ...groups(2, 500)],
      ]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(out?.groups.filter(g => g.chatId === repetido.chat_id)).toHaveLength(1);
      expect(out?.groups).toHaveLength(PAGE_SIZE + 2);
    });

    it('descarta qualquer coisa que não seja @g.us — 1-1 nunca vira candidato', async () => {
      const get = pagedGet([
        [
          { chat_id: '5491162180721@c.us', chat_name: 'Juan' },
          { chat_id: '120363001234567890@g.us', chat_name: 'Flia Perez' },
          { chat_name: 'sem chat_id' },
          { chat_id: 42 },
        ] as never,
      ]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(out?.groups).toEqual([
        { chatId: '120363001234567890@g.us', chatName: 'Flia Perez', memberCount: null, orgPhone: null },
      ]);
    });

    it('grupo sem chat_name e sem member_count vira null nos dois campos', async () => {
      // O Periskope omite campos em vez de mandar null em parte dos grupos —
      // visto na sonda contra produção (750 de 774 tinham nome).
      const get = pagedGet([[{ chat_id: '120363004444444444@g.us' }] as never]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(out?.groups).toEqual([
        { chatId: '120363004444444444@g.us', chatName: null, memberCount: null, orgPhone: null },
      ]);
    });

    it('leva o NÚMERO de origem do grupo', async () => {
      // A leitura é da org inteira, então um grupo pode vir de qualquer número
      // conectado. Saber de qual é o que responde "por que não vejo o meu?" —
      // grupo em que nenhum número nosso entrou não existe para nós.
      const get = pagedGet([[
        { chat_id: '120363005555555555@g.us', chat_name: 'G', org_phone: '5491127671720@c.us' },
      ] as never]);
      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(out?.groups[0].orgPhone).toBe('5491127671720@c.us');
    });

    it('payload sem `chats` e resposta sem body devolvem lista vazia, não null', async () => {
      const semChats = jest.fn().mockResolvedValue({ data: {} });
      expect(await new PeriskopeChatReadService(httpWith(semChats), 0).listGroupChats()).toEqual({
        groups: [],
        truncated: false,
      });

      const semBody = jest.fn().mockResolvedValue({});
      expect(await new PeriskopeChatReadService(httpWith(semBody), 0).listGroupChats()).toEqual({
        groups: [],
        truncated: false,
      });
    });
  });

  describe('listGroupChats — comportamento NO LIMITE', () => {
    it('API que nunca devolve página incompleta para em MAX_PAGES e marca truncated', async () => {
      // Simula a API ignorando `offset`: toda página vem cheia, para sempre.
      const get = jest
        .fn()
        .mockImplementation((_u: string, cfg: { params: { offset: number } }) =>
          Promise.resolve({ data: { chats: groups(PAGE_SIZE, cfg.params.offset) } }),
        );

      const out = await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      expect(get).toHaveBeenCalledTimes(MAX_PAGES);
      expect(out?.groups).toHaveLength(MAX_PAGES * PAGE_SIZE);
      // O ponto do defeito: a incompletude VIAJA no resultado, para chegar à tela.
      expect(out?.truncated).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        { collected: MAX_PAGES * PAGE_SIZE, maxPages: MAX_PAGES, pageSize: PAGE_SIZE },
        expect.stringContaining('lista incompleta'),
      );
    });

    it('lista truncada NÃO entra no cache — não congela um resultado ruim', async () => {
      const get = jest
        .fn()
        .mockImplementation((_u: string, cfg: { params: { offset: number } }) =>
          Promise.resolve({ data: { chats: groups(PAGE_SIZE, cfg.params.offset) } }),
        );
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      const primeira = await svc.listGroupChats();
      const segunda = await svc.listGroupChats();

      expect(primeira?.truncated).toBe(true);
      expect(segunda?.truncated).toBe(true);
      // Varreu de novo: MAX_PAGES por chamada, e não 0 na segunda.
      expect(get).toHaveBeenCalledTimes(MAX_PAGES * 2);
    });
  });

  describe('listGroupChats — cache', () => {
    it('N buscas na janela do TTL = UMA varredura do Periskope', async () => {
      const get = pagedGet([groups(PAGE_SIZE, 0), groups(10, 200)]);
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      for (let i = 0; i < 10; i++) await svc.listGroupChats();

      // 2 páginas na primeira busca; as outras 9 saíram do cache.
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('o resultado cacheado é igual ao da varredura', async () => {
      const get = pagedGet([groups(3)]);
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      expect(await svc.listGroupChats()).toEqual(await svc.listGroupChats());
    });

    it('passado o TTL, varre de novo', async () => {
      jest.useFakeTimers();
      try {
        const get = pagedGet([groups(3)]);
        const svc = new PeriskopeChatReadService(httpWith(get), 1_000);

        await svc.listGroupChats();
        expect(get).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1_001);
        await svc.listGroupChats();
        expect(get).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('forceRefresh ignora o cache', async () => {
      const get = pagedGet([groups(3)]);
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      await svc.listGroupChats();
      await svc.listGroupChats({ forceRefresh: true });

      expect(get).toHaveBeenCalledTimes(2);
    });

    it('clearCache força a próxima busca a varrer', async () => {
      const get = pagedGet([groups(3)]);
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      await svc.listGroupChats();
      svc.clearCache();
      await svc.listGroupChats();

      expect(get).toHaveBeenCalledTimes(2);
    });

    it('TTL 0 desliga o cache', async () => {
      const get = pagedGet([groups(3)]);
      const svc = new PeriskopeChatReadService(httpWith(get), 0);

      await svc.listGroupChats();
      await svc.listGroupChats();

      expect(get).toHaveBeenCalledTimes(2);
    });

    it('cache é por instância — não vaza entre serviços', async () => {
      const getA = pagedGet([groups(3)]);
      const getB = pagedGet([groups(3)]);

      await new PeriskopeChatReadService(httpWith(getA), 60_000).listGroupChats();
      await new PeriskopeChatReadService(httpWith(getB), 60_000).listGroupChats();

      expect(getA).toHaveBeenCalledTimes(1);
      expect(getB).toHaveBeenCalledTimes(1);
    });
  });

  describe('falha e privacidade', () => {
    it('erro HTTP vira null (best-effort) e é reportado', async () => {
      const get = jest.fn().mockRejectedValue(new Error('boom'));
      expect(await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats()).toBeNull();
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'PeriskopeChatReadService:listGroupChats',
      });
    });

    it('rejeição não-Error também vira null', async () => {
      const get = jest.fn().mockRejectedValue('string solta');
      expect(await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats()).toBeNull();
    });

    it('falha no meio da varredura não cacheia nada', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce({ data: { chats: groups(PAGE_SIZE, 0) } })
        .mockRejectedValueOnce(new Error('caiu na página 2'))
        .mockResolvedValue({ data: { chats: groups(2, 0) } });
      const svc = new PeriskopeChatReadService(httpWith(get), 60_000);

      expect(await svc.listGroupChats()).toBeNull();
      // A próxima busca tenta de novo em vez de servir lixo do cache.
      expect((await svc.listGroupChats())?.groups).toHaveLength(2);
    });

    it('NUNCA loga nome de grupo (PII) — só contagens', async () => {
      const get = pagedGet([
        [{ chat_id: '120363001234567890@g.us', chat_name: 'Flia Perez', member_count: 3 }],
      ]);
      await new PeriskopeChatReadService(httpWith(get), 0).listGroupChats();

      const logged =
        JSON.stringify(logger.warn.mock.calls) + JSON.stringify(reportError.mock.calls);
      expect(logged).not.toContain('Perez');
    });

    it('o serviço não expõe nenhum caminho de escrita', () => {
      const svc = new PeriskopeChatReadService(
        httpWith(jest.fn()),
        0,
      ) as unknown as Record<string, unknown>;
      const surface = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(svc)),
        ...Object.keys(svc),
      ];
      expect(surface).not.toContain('send');
      expect(surface).not.toContain('sendToGroup');
      expect(surface).not.toContain('post');
      expect(surface.filter(k => k !== 'constructor').sort()).toEqual([
        'cache',
        'cacheTtlMs',
        'clearCache',
        'http',
        'isConfigured',
        'listGroupChats',
        'readCache',
        'writeCache',
      ]);
    });
  });
});
