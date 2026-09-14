/**
 * accountLinkRoutes — chave do rate limit por IP (`ipKey`).
 *
 * MORRE se o fallback voltar a usar `req.ip`/X-Forwarded-For cru: em IPv6 cada
 * cliente tem um /64 (às vezes /56) inteiro à disposição, então chave por
 * endereço exato deixa a mesma pessoa trocar de sufixo e furar o limite de
 * start/confirm do vínculo self-service (mesma régua do claim/OTP).
 */
import type { Request, Response } from 'express';
import request from 'supertest';
import { appDeRota } from '@shared/__tests__/appDeRota';
import { ipKey, createAccountLinkRoutes } from '../accountLinkRoutes';
import type { AccountLinkController } from '../AccountLinkController';
import type { AuthMiddleware } from '../../identity/interfaces/middleware/AuthMiddleware';

function reqComIp(ip: string | undefined): Request {
  return { headers: {}, ip } as unknown as Request;
}

function reqComForwardedFor(xff: string, ip?: string): Request {
  return { headers: { 'x-forwarded-for': xff }, ip } as unknown as Request;
}

describe('accountLinkRoutes — ipKey', () => {
  it('IPv4 continua funcionando (chave = o próprio endereço)', () => {
    expect(ipKey(reqComIp('10.0.0.1'))).toBe('10.0.0.1');
  });

  it('sem IP nenhum, cai no marcador explícito "unknown"', () => {
    expect(ipKey(reqComIp(undefined))).toBe('unknown');
  });

  it('dois IPv6 do MESMO /56 geram a MESMA chave (ipKeyGenerator, não req.ip cru)', () => {
    const chave1 = ipKey(reqComIp('2001:db8:1:1::1'));
    const chave2 = ipKey(reqComIp('2001:db8:1:1::2'));
    expect(chave1).toBe(chave2);
    expect(chave1).not.toBe('2001:db8:1:1::1');
  });

  it('IPv6 de /56 diferente gera chave diferente', () => {
    const chave1 = ipKey(reqComIp('2001:db8:1:1::1'));
    const chave2 = ipKey(reqComIp('2001:db8:2:1::1'));
    expect(chave1).not.toBe(chave2);
  });

  it('X-Forwarded-For IPv6 também é normalizado (mesmo /56 colapsa)', () => {
    const chave1 = ipKey(reqComForwardedFor('2001:db8:1:1::1, 10.0.0.9'));
    const chave2 = ipKey(reqComForwardedFor('2001:db8:1:1::2, 10.0.0.9'));
    expect(chave1).toBe(chave2);
  });
});

/**
 * createAccountLinkRoutes — monta as 6 rotas e afirma:
 *   1. `flagGate` bloqueia (404) com a flag desligada e DEIXA PASSAR ligada —
 *      as duas pontas do `if`, não só a de 404 (essa já tinha cobertura em
 *      account-link.test.ts).
 *   2. cada rota chega no método certo do controller — sem isso um
 *      `router.post(path, flagGate, ...auth, outroHandler)` passaria mudo.
 *   3. a ORDEM dos middlewares por rota: `flagGate` é sempre o primeiro
 *      (nome da função, não introspecção de posição só numérica), e só
 *      start/confirm têm o rate limiter no meio — lookup/finalize/undo não.
 *   4. os limitadores de start/confirm realmente bloqueiam (429) na conta
 *      certa, provando que estão MONTADOS, não só declarados.
 */
describe('createAccountLinkRoutes — montagem, flagGate e limitadores', () => {
  type RouteLayer = {
    route?: {
      path: string;
      methods?: Record<string, boolean>;
      stack: Array<{ handle: { name: string } }>;
    };
  };

  function encontrarRota(router: ReturnType<typeof createAccountLinkRoutes>, path: string, method: string) {
    const layer = (router as unknown as { stack: RouteLayer[] }).stack.find(
      (l) => l.route?.path === path && l.route?.methods?.[method],
    );
    if (!layer?.route) throw new Error(`rota não encontrada: ${method.toUpperCase()} ${path}`);
    return layer.route;
  }

  const controller = {
    lookup: jest.fn((_req: Request, res: Response) => { res.status(200).json({ m: 'lookup' }); }),
    start: jest.fn((_req: Request, res: Response) => { res.status(200).json({ m: 'start' }); }),
    confirm: jest.fn((_req: Request, res: Response) => { res.status(200).json({ m: 'confirm' }); }),
    finalize: jest.fn((_req: Request, res: Response) => { res.status(200).json({ m: 'finalize' }); }),
    undoPage: jest.fn((_req: Request, res: Response) => { res.status(200).send('undo-page'); }),
    undoExecute: jest.fn((_req: Request, res: Response) => { res.status(200).json({ m: 'undoExecute' }); }),
  } as unknown as AccountLinkController;

  // Passa direto — o que se testa aqui é a MONTAGEM da rota (flagGate +
  // limitador + handler), não a autenticação em si (já coberta em
  // AuthMiddleware.test.ts).
  const authDouble = {
    requireAuth: () => (_req: Request, _res: Response, next: () => void) => next(),
    requirePermission: () => (_req: Request, _res: Response, next: () => void) => next(),
  } as unknown as AuthMiddleware;

  const router = createAccountLinkRoutes(controller, authDouble);
  const server = appDeRota('accountLinkRoutes', '/api', () => router);

  let flagOriginal: string | undefined;
  beforeAll(() => { flagOriginal = process.env.ACCOUNT_LINK_ENABLED; });
  afterAll(() => {
    if (flagOriginal === undefined) delete process.env.ACCOUNT_LINK_ENABLED;
    else process.env.ACCOUNT_LINK_ENABLED = flagOriginal;
  });
  afterEach(() => {
    Object.values(controller).forEach((fn) => (fn as jest.Mock).mockClear());
  });

  describe('as 6 rotas existem, cada uma com flagGate primeiro na pilha', () => {
    it.each([
      ['/workers/me/account-link/lookup', 'post'],
      ['/workers/me/account-link/start', 'post'],
      ['/workers/me/account-link/confirm', 'post'],
      ['/workers/me/account-link/finalize', 'post'],
      ['/account-link/undo/:token', 'get'],
      ['/account-link/undo/:token', 'post'],
    ] as const)('%s %s — primeiro middleware é o flagGate', (path, method) => {
      const rota = encontrarRota(router, path, method);
      expect(rota.stack[0].handle.name).toBe('flagGate');
    });
  });

  describe('ordem: só start/confirm têm rate limiter; lookup/finalize/undo não', () => {
    it('lookup: flagGate + 2 middlewares de auth + handler (SEM rate limit) — 4 na pilha', () => {
      const rota = encontrarRota(router, '/workers/me/account-link/lookup', 'post');
      expect(rota.stack).toHaveLength(4);
    });
    it('finalize: mesma forma do lookup (SEM rate limit) — 4 na pilha', () => {
      const rota = encontrarRota(router, '/workers/me/account-link/finalize', 'post');
      expect(rota.stack).toHaveLength(4);
    });
    it('start: flagGate + rate limit + 2 de auth + handler — 5 na pilha, uma a mais que lookup', () => {
      const rota = encontrarRota(router, '/workers/me/account-link/start', 'post');
      expect(rota.stack).toHaveLength(5);
    });
    it('confirm: mesma forma do start (COM rate limit) — 5 na pilha', () => {
      const rota = encontrarRota(router, '/workers/me/account-link/confirm', 'post');
      expect(rota.stack).toHaveLength(5);
    });
    it('undo GET/POST: só flagGate + handler (SEM auth, SEM rate limit) — 2 na pilha', () => {
      expect(encontrarRota(router, '/account-link/undo/:token', 'get').stack).toHaveLength(2);
      expect(encontrarRota(router, '/account-link/undo/:token', 'post').stack).toHaveLength(2);
    });
  });

  describe('flag OFF — flagGate bloqueia as 6 rotas com 404, controller nunca é chamado', () => {
    beforeEach(() => { delete process.env.ACCOUNT_LINK_ENABLED; });

    it.each([
      ['post', '/api/workers/me/account-link/lookup', 'lookup'],
      ['post', '/api/workers/me/account-link/start', 'start'],
      ['post', '/api/workers/me/account-link/confirm', 'confirm'],
      ['post', '/api/workers/me/account-link/finalize', 'finalize'],
      ['get', '/api/account-link/undo/tok1', 'undoPage'],
      ['post', '/api/account-link/undo/tok1', 'undoExecute'],
    ] as const)('%s %s → 404, %s NÃO chamado', async (metodo, caminho, metodoControlador) => {
      const res = await request(server)[metodo](caminho).send({});
      expect(res.status).toBe(404);
      expect(controller[metodoControlador]).not.toHaveBeenCalled();
    });
  });

  describe('flag ON — flagGate deixa passar (a outra ponta do if, linha do next())', () => {
    beforeEach(() => { process.env.ACCOUNT_LINK_ENABLED = 'true'; });

    it.each([
      ['post', '/api/workers/me/account-link/lookup', 'lookup', { m: 'lookup' }],
      ['post', '/api/workers/me/account-link/finalize', 'finalize', { m: 'finalize' }],
    ] as const)('%s %s → chega no controller.%s', async (metodo, caminho, metodoControlador, corpoEsperado) => {
      const res = await request(server)[metodo](caminho).set('X-Forwarded-For', `on-${metodoControlador}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(corpoEsperado);
      expect(controller[metodoControlador]).toHaveBeenCalledTimes(1);
    });

    it('GET /account-link/undo/:token → chega no controller.undoPage', async () => {
      const res = await request(server).get('/api/account-link/undo/tok-abc').set('X-Forwarded-For', 'on-undoPage');
      expect(res.status).toBe(200);
      expect(res.text).toBe('undo-page');
      expect(controller.undoPage).toHaveBeenCalledTimes(1);
    });

    it('POST /account-link/undo/:token → chega no controller.undoExecute', async () => {
      const res = await request(server).post('/api/account-link/undo/tok-abc').set('X-Forwarded-For', 'on-undoExecute').send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ m: 'undoExecute' });
      expect(controller.undoExecute).toHaveBeenCalledTimes(1);
    });

    it('start: limitador (max=5) MONTADO — a 6ª chamada é 429, sem chegar no controller', async () => {
      const xff = 'on-start-limitador';
      for (let i = 0; i < 5; i++) {
        const ok = await request(server).post('/api/workers/me/account-link/start').set('X-Forwarded-For', xff).send({});
        expect(ok.status).toBe(200);
      }
      (controller.start as jest.Mock).mockClear();
      const bloqueado = await request(server).post('/api/workers/me/account-link/start').set('X-Forwarded-For', xff).send({});
      expect(bloqueado.status).toBe(429);
      expect(bloqueado.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
      expect(controller.start).not.toHaveBeenCalled();
    });

    it('confirm: limitador (max=8) MONTADO — a 9ª chamada é 429, sem chegar no controller', async () => {
      const xff = 'on-confirm-limitador';
      for (let i = 0; i < 8; i++) {
        const ok = await request(server).post('/api/workers/me/account-link/confirm').set('X-Forwarded-For', xff).send({});
        expect(ok.status).toBe(200);
      }
      (controller.confirm as jest.Mock).mockClear();
      const bloqueado = await request(server).post('/api/workers/me/account-link/confirm').set('X-Forwarded-For', xff).send({});
      expect(bloqueado.status).toBe(429);
      expect(bloqueado.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
      expect(controller.confirm).not.toHaveBeenCalled();
    });
  });
});
