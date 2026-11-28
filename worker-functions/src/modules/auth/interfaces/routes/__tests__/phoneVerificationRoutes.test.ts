/**
 * phoneVerificationRoutes — limite anti-abuso de `POST /api/workers/me/phone-verification/{start,confirm}`.
 *
 * No plano B de canal (Twilio Verify) não há linha em `otp_challenges` e nenhum limite no banco: o limite é este.
 * MORRE se o limitador por IP ou por conta sair de qualquer uma das duas rotas (o (N+1)º pedido voltaria 200 e chegaria
 * ao controller), se o corpo do 429 perder `code: 'RATE_LIMITED'`, se o `Retry-After` sumir ou se a chave por IP deixar
 * de normalizar IPv6 (`claimIpKey`). O auth double lê o uid de `X-Test-Uid` (o JWT real põe `req.user.uid`).
 */
import type { Request, Response } from 'express';
import request from 'supertest';
import { appDeRota } from '@shared/__tests__/appDeRota';
import {
  createPhoneVerificationRoutes,
  PHONE_VERIFICATION_IP_MAX,
  PHONE_VERIFICATION_START_UID_MAX,
  PHONE_VERIFICATION_CONFIRM_UID_MAX,
} from '../phoneVerificationRoutes';
import type { PhoneVerificationController } from '../../controllers/PhoneVerificationController';
import type { AuthMiddleware } from '@modules/identity/interfaces/middleware/AuthMiddleware';

/** Store em memória que CONTA as chamadas por prefix: prova que o limitador por uid usa o store compartilhado (o real é o Postgres). */
const mockStoreCalls: string[] = [];
jest.mock('@shared/rateLimit/PgRateLimitStore', () => {
  class MemStore {
    private windowMs = 15 * 60 * 1000;
    private hits = new Map<string, { n: number; reset: number }>();
    constructor(readonly prefix: string) {}
    init(o: { windowMs: number }) { this.windowMs = o.windowMs; }
    async increment(key: string) {
      mockStoreCalls.push(this.prefix);
      const now = Date.now();
      const cur = this.hits.get(key);
      const e = cur && cur.reset > now ? { n: cur.n + 1, reset: cur.reset } : { n: 1, reset: now + this.windowMs };
      this.hits.set(key, e);
      return { totalHits: e.n, resetTime: new Date(e.reset) };
    }
    async decrement(key: string) { const c = this.hits.get(key); if (c) c.n = Math.max(c.n - 1, 0); }
    async resetKey(key: string) { this.hits.delete(key); }
  }
  return { createPgRateLimitStore: (prefix: string) => new MemStore(prefix) };
});

const START = '/api/workers/me/phone-verification/start';
const CONFIRM = '/api/workers/me/phone-verification/confirm';

function novoController() {
  return {
    start: jest.fn(async (_req: Request, res: Response) => { res.status(200).json({ m: 'start' }); }),
    confirm: jest.fn(async (_req: Request, res: Response) => { res.status(200).json({ m: 'confirm' }); }),
  };
}

/** Dublê do requireAuth real: sem `X-Test-Uid` → 401; com → popula req.user.uid. */
const authComUid = {
  requireAuth: () => (req: Request, res: Response, next: () => void) => {
    const uid = req.headers['x-test-uid'];
    if (typeof uid !== 'string' || uid === '') {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    (req as Request & { user?: { uid: string } }).user = { uid };
    next();
  },
  requirePermission: () => (_req: Request, _res: Response, next: () => void) => next(),
} as unknown as AuthMiddleware;

function montar(chave: string) {
  const controller = novoController();
  const router = createPhoneVerificationRoutes(controller as unknown as PhoneVerificationController, authComUid);
  const server = appDeRota(chave, '/api', () => router);
  const chamar = (url: string, uid: string, ip: string) =>
    request(server).post(url).set('X-Test-Uid', uid).set('X-Forwarded-For', ip).send({});
  return { controller, router, server, chamar };
}

describe('phoneVerificationRoutes — montagem', () => {
  type RouteLayer = { route?: { path: string; methods?: Record<string, boolean>; stack: unknown[] } };
  const { router } = montar('pvMontagem');
  const rota = (path: string) =>
    (router as unknown as { stack: RouteLayer[] }).stack.find((l) => l.route?.path === path && l.route?.methods?.post)?.route;

  it.each([
    ['/workers/me/phone-verification/start'],
    ['/workers/me/phone-verification/confirm'],
  ])('%s: routeClass + limite IP + 2 de auth + limite conta + handler — 6 na pilha', (path) => {
    expect(rota(path)?.stack).toHaveLength(6);
  });

  it('os números declarados: IP 30, start 3 por conta, confirm 5 por conta', () => {
    expect([PHONE_VERIFICATION_IP_MAX, PHONE_VERIFICATION_START_UID_MAX, PHONE_VERIFICATION_CONFIRM_UID_MAX]).toEqual([30, 3, 5]);
  });
});

describe.each([
  ['start', START, PHONE_VERIFICATION_START_UID_MAX, 'start'],
  ['confirm', CONFIRM, PHONE_VERIFICATION_CONFIRM_UID_MAX, 'confirm'],
] as const)('phoneVerificationRoutes — %s: limite por CONTA', (nome, url, max, metodo) => {
  const { controller, chamar } = montar(`pvConta-${nome}`);
  afterEach(() => controller[metodo].mockClear());

  it(`o ${max + 1}º da mesma conta é 429 (code RATE_LIMITED + Retry-After), mesmo variando o IP, sem chegar ao controller`, async () => {
    for (let i = 0; i < max; i++) {
      expect((await chamar(url, 'conta-A', `ip-a-${i}`)).status).toBe(200);
    }
    controller[metodo].mockClear();
    const bloqueado = await chamar(url, 'conta-A', 'ip-a-novo');
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0);
    expect(controller[metodo]).not.toHaveBeenCalled();
  });

  it('outra conta (mesmo IP) segue 200 depois que a conta A estourou', async () => {
    const ok = await chamar(url, 'conta-B', 'ip-a-novo');
    expect(ok.status).toBe(200);
    expect(controller[metodo]).toHaveBeenCalledTimes(1);
  });

  it('sem token: 401 do auth (o limite por conta só roda depois dele)', async () => {
    const anonimo = await request(montar(`pvAnon-${nome}`).server).post(url).set('X-Forwarded-For', 'ip-anon').send({});
    expect(anonimo.status).toBe(401);
  });
});

describe.each([
  ['start', START, 'start'],
  ['confirm', CONFIRM, 'confirm'],
] as const)('phoneVerificationRoutes — %s: limite por IP', (nome, url, metodo) => {
  const { controller, chamar, server } = montar(`pvIp-${nome}`);
  afterEach(() => controller[metodo].mockClear());

  it(`o ${PHONE_VERIFICATION_IP_MAX + 1}º do mesmo IP é 429 com contas diferentes (code + Retry-After), sem chegar ao controller`, async () => {
    for (let i = 0; i < PHONE_VERIFICATION_IP_MAX; i++) {
      expect((await chamar(url, `conta-ip-${i}`, 'ip-compartilhado')).status).toBe(200);
    }
    controller[metodo].mockClear();
    const bloqueado = await chamar(url, 'conta-ip-nova', 'ip-compartilhado');
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0);
    expect(controller[metodo]).not.toHaveBeenCalled();
  });

  it('o limite por IP roda ANTES do auth: com a cota do IP cheia, até o pedido sem token leva 429 (não 401)', async () => {
    const livre = await request(server).post(url).set('X-Forwarded-For', 'ip-livre').send({});
    expect(livre.status).toBe(401); // IP com cota livre → chega ao auth
    const semToken = await request(server).post(url).set('X-Forwarded-For', 'ip-compartilhado').send({});
    expect(semToken.status).toBe(429);
  });

  it('a chave é a do claim (claimIpKey): IPv6 diferentes do MESMO /56 dividem a cota', async () => {
    const { chamar: chamar6 } = montar(`pvIpv6-${nome}`);
    for (let i = 0; i < PHONE_VERIFICATION_IP_MAX; i++) {
      expect((await chamar6(url, `conta-v6-${i}`, `2001:db8:9:1::${i + 1}`)).status).toBe(200);
    }
    expect((await chamar6(url, 'conta-v6-nova', '2001:db8:9:1::ff')).status).toBe(429);
  });
});

describe('phoneVerificationRoutes — limite por conta usa o store compartilhado (B2)', () => {
  beforeEach(() => { mockStoreCalls.length = 0; });

  it.each([
    ['start', START, 'pv-start-uid'],
    ['confirm', CONFIRM, 'pv-confirm-uid'],
  ])('%s: o limitador por conta chama o store compartilhado', async (_nome, url, prefix) => {
    const { chamar } = montar(`pvStore-${prefix}`);
    expect((await chamar(url, 'uid-teste-store', '1.2.3.4')).status).toBe(200);
    expect(mockStoreCalls).toEqual([prefix]);
  });
});
