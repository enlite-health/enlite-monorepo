/**
 * O `startServer` ganhou um hook `beforeListen` (change `painel-grupos-permissao`,
 * grupo 3) e ele só vale alguma coisa se for MESMO antes do `listen`: um gate
 * que roda depois do servidor aceitar tráfego não é gate, é log.
 *
 * O que se prova aqui é exatamente esse contrato — e o simétrico, que sem hook
 * nada muda. Todo o resto do arquivo (webhooks, Pub/Sub, Cloud Tasks) é
 * substituído: é wiring de terceiros e não é o objeto do teste.
 */

const listenMock = jest.fn();
const assertDbRoleMembershipMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@shared/database/assertDbRoleMembership', () => ({
  assertDbRoleMembership: (...args: unknown[]) => assertDbRoleMembershipMock(...args),
}));
const closePoolsMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => ({ query: jest.fn() }),
      getRawPool: () => ({ query: jest.fn() }),
      getSystemPool: () => ({ query: jest.fn() }),
      close: (...args: unknown[]) => closePoolsMock(...args),
    }),
  },
}));
jest.mock('@modules/integration', () => ({
  createWebhookRoutes: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  PartnerAuthMiddleware: class {},
  GoogleApiKeyValidator: class {},
  WebhookPartnerRepository: class {},
}));
jest.mock('@modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController', () => ({
  ClickUpPatientWebhookController: class {},
}));
jest.mock('@modules/integration/interfaces/webhooks/middleware/ClickUpHmacMiddleware', () => ({
  ClickUpHmacMiddleware: class {
    handle = (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('@shared/events/PubSubClient', () => ({ PubSubClient: class {} }));
jest.mock('@shared/events/CloudTasksClient', () => ({ CloudTasksClient: class {} }));
jest.mock('@modules/notification/application/BookSlotFromWhatsAppUseCase', () => ({ BookSlotFromWhatsAppUseCase: class {} }));
jest.mock('@modules/notification/application/HandleReminderResponseUseCase', () => ({ HandleReminderResponseUseCase: class {} }));
jest.mock('@modules/notification/application/PeriskopeInboundRouter', () => ({ PeriskopeInboundRouter: class {} }));
jest.mock('@modules/notification/application/TriggerWorkerHandoverUseCase', () => ({ TriggerWorkerHandoverUseCase: class {} }));
jest.mock('@modules/notification/interfaces/controllers/InboundWhatsAppController', () => ({ InboundWhatsAppController: class {} }));
jest.mock('@modules/notification/interfaces/controllers/PeriskopeWebhookController', () => ({ PeriskopeWebhookController: class {} }));
jest.mock('@modules/notification/infrastructure/PeriskopeTicketService', () => ({ PeriskopeTicketService: class {} }));
jest.mock('@modules/notification/infrastructure/PeriskopeNoteService', () => ({ PeriskopeNoteService: class {} }));
const chatwootHandleMock = jest.fn();
jest.mock('@modules/notification/interfaces/controllers/ChatwootMirrorController', () => ({
  ChatwootMirrorController: class {
    handle = (...args: unknown[]) => chatwootHandleMock(...args);
  },
}));
jest.mock('@modules/matching', () => ({ GoogleCalendarService: class {} }));
const chatwootClientMock = jest.fn().mockReturnValue({});
jest.mock('../buildChatwootClient', () => ({ buildChatwootClient: () => chatwootClientMock() }));

import { startServer } from '../startServer';

/** App mínima: só precisa aceitar montagem de rota e registrar o `listen`. */
function fakeApp(): unknown {
  return {
    use: jest.fn(),
    get: jest.fn(),
    post: jest.fn(),
    listen: (...args: unknown[]) => {
      listenMock(...args);
      const callback = args[1];
      if (typeof callback === 'function') callback();
      return { timeout: 0, keepAliveTimeout: 0, headersTimeout: 0, close: jest.fn() };
    },
  };
}

const messaging = { twilioMessagingService: {}, periskopeMessagingService: {} } as never;

describe('startServer — hook beforeListen', () => {
  beforeEach(() => {
    listenMock.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem hook, o servidor sobe como sempre', async () => {
    await startServer(fakeApp() as never, false, messaging);
    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it('roda o hook ANTES do listen', async () => {
    const ordem: string[] = [];
    listenMock.mockImplementation(() => ordem.push('listen'));

    await startServer(fakeApp() as never, false, messaging, {
      beforeListen: async () => {
        ordem.push('hook');
      },
    });

    expect(ordem).toEqual(['hook', 'listen']);
  });

  it('hook que lança IMPEDE o listen e rejeita — é o que faz dele um gate', async () => {
    const falha = new Error('[perm] migração de dados não marcada');

    await expect(
      startServer(fakeApp() as never, false, messaging, {
        beforeListen: () => Promise.reject(falha),
      }),
    ).rejects.toThrow(falha);

    // A revisão anterior do Cloud Run continua servindo justamente porque esta
    // aqui nunca chega a aceitar tráfego.
    expect(listenMock).not.toHaveBeenCalled();
  });

  it('o gate de membership de role continua rodando antes de tudo', async () => {
    assertDbRoleMembershipMock.mockClear();
    await startServer(fakeApp() as never, false, messaging);
    expect(assertDbRoleMembershipMock).toHaveBeenCalled();
  });
});

/**
 * Ramos que já existiam antes deste PR e nunca tiveram teste. Entram junto
 * porque o arquivo passou a ter suíte: ramo de wiring sem cobertura é onde um
 * webhook some sem ninguém perceber.
 */
describe('startServer — ramos de wiring e desligamento', () => {
  const envAnterior = { ...process.env };
  beforeEach(() => {
    listenMock.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...envAnterior };
    jest.restoreAllMocks();
  });

  it('o espelho do Chatwoot é montado e delega ao controller', async () => {
    const app = fakeApp() as { post: jest.Mock };

    await startServer(app as never, false, messaging);

    const rota = app.post.mock.calls.find((c) => String(c[0]).includes('chatwoot/mirror'));
    expect(rota).toBeDefined();
    // O handler inline é fino de propósito — o que importa é que ele chega no
    // controller (é o ponto onde o espelho de conversa entra no sistema).
    const handler = rota?.[rota.length - 1] as (req: unknown, res: unknown) => void;
    handler({ body: {} }, {});
    expect(chatwootHandleMock).toHaveBeenCalled();
  });

  it('sem Chatwoot configurado, o boot segue (o cliente é opcional)', async () => {
    chatwootClientMock.mockReturnValueOnce(null);
    await expect(startServer(fakeApp() as never, false, messaging)).resolves.toBeUndefined();
    expect(listenMock).toHaveBeenCalled();
  });

  it('anuncia o motor de autorização em uso', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await startServer(fakeApp() as never, true, messaging);
    expect(log.mock.calls.flat().some((l) => String(l).includes('Authorization engine: Cerbos'))).toBe(true);
  });

  it('liga o inbound do Periskope quando a flag está ligada', async () => {
    process.env.PERISKOPE_WEBHOOK_ENABLED = 'true';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await startServer(fakeApp() as never, false, messaging);

    // O controller é INJETADO em `createWebhookRoutes` (não vira rota própria),
    // então o sinal observável do ramo é o log de boot.
    expect(log.mock.calls.flat().some((l) => String(l).includes('Periskope inbound webhook'))).toBe(true);
  });

  it('falha ao inicializar o controller do ClickUp NÃO derruba o boot — só some a rota', async () => {
    process.env.CLICKUP_WEBHOOK_SECRET = 'segredo';
    const { ClickUpPatientWebhookController } = jest.requireMock(
      '@modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController',
    ) as { ClickUpPatientWebhookController: { create?: () => Promise<unknown> } };
    ClickUpPatientWebhookController.create = () => Promise.reject(new Error('sem credencial'));

    await expect(startServer(fakeApp() as never, false, messaging)).resolves.toBeUndefined();
    expect(listenMock).toHaveBeenCalled();
  });

  it('com o controller do ClickUp OK, o HMAC é montado junto', async () => {
    process.env.CLICKUP_WEBHOOK_SECRET = 'segredo';
    const { ClickUpPatientWebhookController } = jest.requireMock(
      '@modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController',
    ) as { ClickUpPatientWebhookController: { create?: () => Promise<unknown> } };
    ClickUpPatientWebhookController.create = () => Promise.resolve({});
    const erro = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await startServer(fakeApp() as never, false, messaging);

    expect(erro.mock.calls.flat().some((l) => String(l).includes('ClickUp webhook controller init failed'))).toBe(false);
  });

  it('SIGTERM para de aceitar conexões antes de drenar os pools', async () => {
    const close = jest.fn();
    const app = {
      use: jest.fn(),
      get: jest.fn(),
      post: jest.fn(),
      listen: (...args: unknown[]) => {
        listenMock(...args);
        const callback = args[1];
        if (typeof callback === 'function') callback();
        return { timeout: 0, keepAliveTimeout: 0, headersTimeout: 0, close };
      },
    };

    await startServer(app as never, false, messaging);
    process.emit('SIGTERM');

    // `close` sem callback executado: nada de `process.exit` no teste, e é
    // exatamente a ordem que importa — parar de aceitar vem primeiro.
    expect(close).toHaveBeenCalledTimes(1);
  });

  /** Servidor cujo `close` guarda o callback, para o teste decidir quando drena. */
  function appComCloseControlado(): { app: unknown; fechar: () => void } {
    let aoFechar: (() => void) | undefined;
    const app = {
      use: jest.fn(),
      get: jest.fn(),
      post: jest.fn(),
      listen: (...args: unknown[]) => {
        listenMock(...args);
        const callback = args[1];
        if (typeof callback === 'function') callback();
        return {
          timeout: 0,
          keepAliveTimeout: 0,
          headersTimeout: 0,
          close: (cb: () => void) => {
            aoFechar = cb;
          },
        };
      },
    };
    return { app, fechar: () => aoFechar?.() };
  }

  it('falha ao drenar os pools é logada e o processo ainda sai limpo', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const erro = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    closePoolsMock.mockRejectedValueOnce(new Error('pool travado'));
    const { app, fechar } = appComCloseControlado();

    await startServer(app as never, false, messaging);
    process.emit('SIGTERM');
    fechar();
    await new Promise((resolve) => setImmediate(resolve));

    expect(erro.mock.calls.flat().some((l) => String(l).includes('falha ao drenar pools'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('teto de 8s: se as requests em voo não terminam, sai com 1', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // `close` que NUNCA chama de volta = request em voo que não termina.
    const { app } = appComCloseControlado();

    await startServer(app as never, false, messaging);
    process.emit('SIGTERM');
    jest.advanceTimersByTime(8000);

    expect(exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });

  it('terminado o close, drena os pools e sai com 0', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { app, fechar } = appComCloseControlado();

    await startServer(app as never, false, messaging);
    process.emit('SIGTERM');
    fechar();
    // O drain é assíncrono (`.finally`) — uma volta no microtask basta.
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledWith(0);
  });
});
