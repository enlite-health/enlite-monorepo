/**
 * claimRoutes — chave do rate limit de claim/start e claim/confirm (`claimIpKey`).
 *
 * MORRE se o fallback voltar a usar `req.ip`/X-Forwarded-For cru: em IPv6 cada
 * cliente tem um /64 (às vezes /56) inteiro à disposição, então chave por
 * endereço exato deixa a mesma pessoa trocar de sufixo e furar o limite de
 * OTP — a mesma enumeração que o rate limit existe para impedir.
 */
import type { Request, Response } from 'express';
import request from 'supertest';
import { appDeRota } from '@shared/__tests__/appDeRota';
import { Router } from 'express';
import { claimIpKey, createClaimRoutes, createWorkerInitOtpRateLimit, markOtpStarted } from '../claimRoutes';
import type { ClaimController } from '../../controllers/ClaimController';
import type { AuthMiddleware } from '@modules/identity/interfaces/middleware/AuthMiddleware';

/** Dublê do requireAuth real: sem `Authorization: Bearer` → 401; com → popula req.user. */
const authMiddleware = {
  requireAuth: () => (req: Request, res: Response, next: () => void) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    (req as Request & { user?: unknown }).user = { uid: 'uid-sintetico-1', email: 'a@exemplo.test' };
    next();
  },
} as unknown as AuthMiddleware;
const BEARER = { Authorization: 'Bearer token-sintetico' };

function reqComIp(ip: string | undefined): Request {
  return { headers: {}, ip } as unknown as Request;
}

function reqComForwardedFor(xff: string, ip?: string): Request {
  return { headers: { 'x-forwarded-for': xff }, ip } as unknown as Request;
}

describe('claimRoutes — claimIpKey', () => {
  it('IPv4 continua funcionando (chave = o próprio endereço)', () => {
    expect(claimIpKey(reqComIp('10.0.0.1'))).toBe('10.0.0.1');
  });

  it('sem IP nenhum, cai no marcador explícito "unknown"', () => {
    expect(claimIpKey(reqComIp(undefined))).toBe('unknown');
  });

  it('dois IPv6 do MESMO /56 geram a MESMA chave (ipKeyGenerator, não req.ip cru)', () => {
    const chave1 = claimIpKey(reqComIp('2001:db8:1:1::1'));
    const chave2 = claimIpKey(reqComIp('2001:db8:1:1::2'));
    expect(chave1).toBe(chave2);
    expect(chave1).not.toBe('2001:db8:1:1::1');
  });

  it('IPv6 de /56 diferente gera chave diferente', () => {
    const chave1 = claimIpKey(reqComIp('2001:db8:1:1::1'));
    const chave2 = claimIpKey(reqComIp('2001:db8:2:1::1'));
    expect(chave1).not.toBe(chave2);
  });

  it('X-Forwarded-For IPv6 também é normalizado (mesmo /56 colapsa)', () => {
    const chave1 = claimIpKey(reqComForwardedFor('2001:db8:1:1::1, 10.0.0.9'));
    const chave2 = claimIpKey(reqComForwardedFor('2001:db8:1:1::2, 10.0.0.9'));
    expect(chave1).toBe(chave2);
  });
});

/**
 * createClaimRoutes — monta as duas rotas e afirma que o limitador está
 * REALMENTE no meio do caminho (não só declarado): a chamada que estoura o
 * `max` volta 429 antes de chegar no controller. Sem isso a linha do
 * `router.post(..., claimStartRateLimit/claimConfirmRateLimit, ...)` fica sem
 * prova — um `router.post(path, handler)` sem o limitador passaria no mesmo
 * teste de "rota existe e chama o controller".
 */
describe('createClaimRoutes — montagem das rotas e limitador no lugar certo', () => {
  const controller = {
    start: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'start' }); }),
    confirm: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'confirm' }); }),
  } as unknown as ClaimController;

  const server = appDeRota('claimRoutes', '/api', () => createClaimRoutes(controller, authMiddleware));

  afterEach(() => {
    (controller.start as jest.Mock).mockClear();
    (controller.confirm as jest.Mock).mockClear();
  });

  it('POST /api/auth/claim/start existe e chega no controller.start', async () => {
    const res = await request(server)
      .post('/api/auth/claim/start')
      .set(BEARER).set('X-Forwarded-For', 'claim-start-existe')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ m: 'start' });
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('POST /api/auth/claim/confirm existe e chega no controller.confirm', async () => {
    const res = await request(server)
      .post('/api/auth/claim/confirm')
      .set(BEARER).set('X-Forwarded-For', 'claim-confirm-existe')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ m: 'confirm' });
    expect(controller.confirm).toHaveBeenCalledTimes(1);
  });

  it('claim/start: o limitador (max=3) está MONTADO ANTES do controller — a 4ª chamada é 429, sem chegar no controller', async () => {
    const xff = 'claim-start-limitador';
    for (let i = 0; i < 3; i++) {
      const ok = await request(server).post('/api/auth/claim/start').set(BEARER).set('X-Forwarded-For', xff).send({});
      expect(ok.status).toBe(200);
    }
    (controller.start as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/start').set(BEARER).set('X-Forwarded-For', xff).send({});
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, error: expect.stringContaining('OTP') });
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('claim/confirm: o limitador (max=5) está MONTADO ANTES do controller — a 6ª chamada é 429, sem chegar no controller', async () => {
    const xff = 'claim-confirm-limitador';
    for (let i = 0; i < 5; i++) {
      const ok = await request(server).post('/api/auth/claim/confirm').set(BEARER).set('X-Forwarded-For', xff).send({});
      expect(ok.status).toBe(200);
    }
    (controller.confirm as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/confirm').set(BEARER).set('X-Forwarded-For', xff).send({});
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, error: expect.stringContaining('confirmation') });
    expect(controller.confirm).not.toHaveBeenCalled();
  });
});

describe('createClaimRoutes — H3 (D650): requireAuth nas duas rotas, DEPOIS do rate limit', () => {
  const controller = {
    start: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'start' }); }),
    confirm: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'confirm' }); }),
  } as unknown as ClaimController;
  const server = appDeRota('claimRoutesH3', '/api', () => createClaimRoutes(controller, authMiddleware));

  afterEach(() => {
    (controller.start as jest.Mock).mockClear();
    (controller.confirm as jest.Mock).mockClear();
  });

  it.each(['start', 'confirm'])('claim/%s sem token → 401 e o controller NÃO é chamado', async (rota) => {
    const res = await request(server).post(`/api/auth/claim/${rota}`).set('X-Forwarded-For', `h3-sem-token-${rota}`).send({});
    expect(res.status).toBe(401);
    expect((controller as unknown as Record<string, jest.Mock>)[rota]).not.toHaveBeenCalled();
  });

  it('o rate limit vem ANTES do requireAuth: rajada anônima estoura 429, não 401 infinito', async () => {
    const xff = 'h3-rajada-anonima';
    for (let i = 0; i < 3; i++) {
      const r = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', xff).send({});
      expect(r.status).toBe(401);
    }
    const bloqueado = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', xff).send({});
    expect(bloqueado.status).toBe(429);
  });
});

/**
 * LIGAÇÃO real, não só a função isolada: os testes acima de "limitador no
 * lugar certo" usam um X-Forwarded-For OPACO (string qualquer) — se alguém
 * trocar a linha `keyGenerator: claimIpKey` por um inline que lê o
 * X-Forwarded-For/`req.ip` CRU (sem `ipKeyGenerator`), esses testes continuam
 * verdes, porque uma string opaca não muda sob (não-)normalização.
 *
 * Aqui a prova é com ENDEREÇOS IPv6 REAIS do MESMO /56: se o site realmente
 * usa `claimIpKey` (com `ipKeyGenerator`), N endereços diferentes do mesmo
 * /56 colapsam na MESMA chave e o limite estoura na N+1ª chamada — sabotar a
 * LINHA `keyGenerator:` (não só o corpo de `claimIpKey`) faz este teste cair.
 */
describe('createClaimRoutes — LIGAÇÃO real com IPv6 (mesmo /56 deve colapsar, não string opaca)', () => {
  const controller = {
    start: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'start' }); }),
    confirm: jest.fn((req: Request, res: Response) => { res.status(200).json({ m: 'confirm' }); }),
  } as unknown as ClaimController;

  const server = appDeRota('claimRoutesWiring', '/api', () => createClaimRoutes(controller, authMiddleware));

  afterEach(() => {
    (controller.start as jest.Mock).mockClear();
    (controller.confirm as jest.Mock).mockClear();
  });

  it('claim/start: 3 IPv6 DIFERENTES do MESMO /56 esgotam o max=3 — a 4ª (outro endereço do mesmo /56) é 429', async () => {
    const enderecos = ['2001:db8:1:1::40', '2001:db8:1:1::41', '2001:db8:1:1::42', '2001:db8:1:1::43'];
    for (let i = 0; i < 3; i++) {
      const ok = await request(server).post('/api/auth/claim/start').set(BEARER).set('X-Forwarded-For', enderecos[i]).send({});
      expect(ok.status).toBe(200);
    }
    (controller.start as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/start').set(BEARER).set('X-Forwarded-For', enderecos[3]).send({});
    expect(bloqueado.status).toBe(429);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('claim/confirm: 5 IPv6 DIFERENTES do MESMO /56 esgotam o max=5 — a 6ª (outro endereço do mesmo /56) é 429', async () => {
    const enderecos = [
      '2001:db8:1:1::50', '2001:db8:1:1::51', '2001:db8:1:1::52',
      '2001:db8:1:1::53', '2001:db8:1:1::54', '2001:db8:1:1::55',
    ];
    for (let i = 0; i < 5; i++) {
      const ok = await request(server).post('/api/auth/claim/confirm').set(BEARER).set('X-Forwarded-For', enderecos[i]).send({});
      expect(ok.status).toBe(200);
    }
    (controller.confirm as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/confirm').set(BEARER).set('X-Forwarded-For', enderecos[5]).send({});
    expect(bloqueado.status).toBe(429);
    expect(controller.confirm).not.toHaveBeenCalled();
  });
});

/**
 * DP-20: o `POST /api/workers/init` dispara SMS (`claim_pending`) — inclusive pelo e-mail da ficha
 * com token não verificado, que qualquer um consegue. O limitador do init é o do claim/start
 * (3 por IP em 15 min, mesma chave), contando só a resposta que abriu OTP (`markOtpStarted`).
 * MORRE se o limitador sair, se a cota mudar ou se passar a contar o init sem SMS.
 */
describe('createWorkerInitOtpRateLimit — cota de OTP do init', () => {
  const enviaOtp = jest.fn((req: Request, res: Response) => {
    if (req.headers['x-teste-otp'] === '1') markOtpStarted(res); // como o controller faz no claim_pending
    res.status(200).json({ m: 'init' });
  });
  const server = appDeRota('workerInitOtp', '/api', () => {
    const r = Router();
    r.post('/workers/init', createWorkerInitOtpRateLimit(), enviaOtp);
    return r;
  });
  const init = (xff: string, otp: boolean) =>
    request(server).post('/api/workers/init').set('X-Forwarded-For', xff).set('X-Teste-Otp', otp ? '1' : '0').send({});

  afterEach(() => enviaOtp.mockClear());

  it('3 inits que abriram OTP passam; a 4ª chamada é 429 e NÃO chega ao use case (sem novo envio)', async () => {
    const xff = 'init-otp-bombardeio';
    for (let i = 0; i < 3; i++) expect((await init(xff, true)).status).toBe(200);
    enviaOtp.mockClear();
    const bloqueado = await init(xff, true);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, error: expect.stringContaining('OTP') });
    expect(enviaOtp).not.toHaveBeenCalled();
  });

  it('init SEM OTP (login, cadastro novo) não gasta a cota: 10 deles e ainda cabem 3 com OTP', async () => {
    const xff = 'init-sem-otp';
    for (let i = 0; i < 10; i++) expect((await init(xff, false)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await init(xff, true)).status).toBe(200);
    expect((await init(xff, true)).status).toBe(429);
  });

  it('a chave é a do claim (claimIpKey): IPv6 do MESMO /56 dividem a cota', async () => {
    const enderecos = ['2001:db8:7:1::1', '2001:db8:7:1::2', '2001:db8:7:1::3', '2001:db8:7:1::4'];
    for (let i = 0; i < 3; i++) expect((await init(enderecos[i], true)).status).toBe(200);
    expect((await init(enderecos[3], true)).status).toBe(429);
  });
});

/**
 * Chave da cota do init por canal: pelo BFF o IP é o de saída do Cloud Run (comum a todas as cuidadoras),
 * então no canal app (marca do `appChannel`) a chave é o uid do JWT; na web continua o IP.
 * Montagem na ORDEM real do index.ts: requireAuth → appChannel → limitador → controller.
 * MORRE se a chave do canal app voltar a ser o IP (4 uids diferentes dariam 429) ou se a web deixar de ser por IP.
 */
describe('createWorkerInitOtpRateLimit — chave por canal (app: uid, web: IP)', () => {
  const enviaOtp = jest.fn((_req: Request, res: Response) => {
    markOtpStarted(res); // todo init aqui abre OTP, para gastar a cota
    res.status(200).json({ m: 'init' });
  });
  /** Dublê do requireAuth: uid vem de X-Teste-Uid; sem ele, 401 (o limitador nem é alcançado). */
  const auth = (req: Request, res: Response, next: () => void) => {
    const uid = req.headers['x-teste-uid'];
    if (!uid) { res.status(401).json({ success: false }); return; }
    (req as Request & { user?: unknown }).user = { uid: String(uid), email: `${uid}@exemplo.test` };
    next();
  };
  /** Dublê do appChannel com token VALIDADO: marca o canal app quando X-Teste-Canal=app. */
  const canal = (req: Request, res: Response, next: () => void) => {
    if (req.headers['x-teste-canal'] === 'app') res.locals.profileEditChannel = 'app';
    next();
  };
  const server = appDeRota('workerInitOtpCanal', '/api', () => {
    const r = Router();
    r.post('/workers/init', auth, canal, createWorkerInitOtpRateLimit(), enviaOtp);
    return r;
  });
  const init = (uid: string | undefined, ip: string, app: boolean) => {
    let rq = request(server).post('/api/workers/init').set('X-Forwarded-For', ip).set('X-Teste-Canal', app ? 'app' : 'web');
    if (uid) rq = rq.set('X-Teste-Uid', uid);
    return rq.send({});
  };

  afterEach(() => enviaOtp.mockClear());

  it('canal app: 4 uids DIFERENTES atrás do MESMO IP (saída do Cloud Run) não levam 429', async () => {
    for (const u of ['app-u1', 'app-u2', 'app-u3', 'app-u4']) {
      expect((await init(u, 'cloud-run-egress-1', true)).status).toBe(200);
    }
  });

  it('canal app: 4 inits do MESMO uid levam 429 na 4ª, e o use case não é chamado', async () => {
    for (let i = 0; i < 3; i++) expect((await init('app-mesmo', 'cloud-run-egress-2', true)).status).toBe(200);
    enviaOtp.mockClear();
    const r = await init('app-mesmo', 'cloud-run-egress-2', true);
    expect(r.status).toBe(429);
    expect(enviaOtp).not.toHaveBeenCalled();
  });

  it('canal app: o uid é a chave, não o IP — trocar de IP não zera a cota', async () => {
    for (let i = 0; i < 3; i++) expect((await init('app-troca-ip', `egress-troca-${i}`, true)).status).toBe(200);
    expect((await init('app-troca-ip', 'egress-troca-novo', true)).status).toBe(429);
  });

  it('web (sem marca): continua POR IP — 4 uids diferentes do mesmo IP levam 429 na 4ª', async () => {
    for (const u of ['web-u1', 'web-u2', 'web-u3']) expect((await init(u, 'ip-web-1', false)).status).toBe(200);
    expect((await init('web-u4', 'ip-web-1', false)).status).toBe(429);
  });

  it('web: o mesmo uid em IPs diferentes não divide cota (por IP, inalterado)', async () => {
    for (let i = 0; i < 4; i++) expect((await init('web-mesmo-uid', `ip-web-diverso-${i}`, false)).status).toBe(200);
  });

  it('as cotas dos canais não se misturam: uid no app e IP na web são chaves distintas', async () => {
    for (let i = 0; i < 3; i++) expect((await init('app-x', 'ip-compartilhado', true)).status).toBe(200);
    expect((await init('web-y', 'ip-compartilhado', false)).status).toBe(200);
  });

  it('anônimo leva 401 do requireAuth, sem gastar cota nem chegar ao use case', async () => {
    for (let i = 0; i < 5; i++) expect((await init(undefined, 'anon-ip', true)).status).toBe(401);
    expect(enviaOtp).not.toHaveBeenCalled();
    expect((await init('app-depois-do-anonimo', 'anon-ip', true)).status).toBe(200);
  });
});
