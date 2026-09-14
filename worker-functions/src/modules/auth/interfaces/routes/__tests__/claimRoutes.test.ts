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
import { claimIpKey, createClaimRoutes } from '../claimRoutes';
import type { ClaimController } from '../../controllers/ClaimController';

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

  const server = appDeRota('claimRoutes', '/api', () => createClaimRoutes(controller));

  afterEach(() => {
    (controller.start as jest.Mock).mockClear();
    (controller.confirm as jest.Mock).mockClear();
  });

  it('POST /api/auth/claim/start existe e chega no controller.start', async () => {
    const res = await request(server)
      .post('/api/auth/claim/start')
      .set('X-Forwarded-For', 'claim-start-existe')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ m: 'start' });
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('POST /api/auth/claim/confirm existe e chega no controller.confirm', async () => {
    const res = await request(server)
      .post('/api/auth/claim/confirm')
      .set('X-Forwarded-For', 'claim-confirm-existe')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ m: 'confirm' });
    expect(controller.confirm).toHaveBeenCalledTimes(1);
  });

  it('claim/start: o limitador (max=3) está MONTADO ANTES do controller — a 4ª chamada é 429, sem chegar no controller', async () => {
    const xff = 'claim-start-limitador';
    for (let i = 0; i < 3; i++) {
      const ok = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', xff).send({});
      expect(ok.status).toBe(200);
    }
    (controller.start as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', xff).send({});
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, error: expect.stringContaining('OTP') });
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('claim/confirm: o limitador (max=5) está MONTADO ANTES do controller — a 6ª chamada é 429, sem chegar no controller', async () => {
    const xff = 'claim-confirm-limitador';
    for (let i = 0; i < 5; i++) {
      const ok = await request(server).post('/api/auth/claim/confirm').set('X-Forwarded-For', xff).send({});
      expect(ok.status).toBe(200);
    }
    (controller.confirm as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/confirm').set('X-Forwarded-For', xff).send({});
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ success: false, error: expect.stringContaining('confirmation') });
    expect(controller.confirm).not.toHaveBeenCalled();
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

  const server = appDeRota('claimRoutesWiring', '/api', () => createClaimRoutes(controller));

  afterEach(() => {
    (controller.start as jest.Mock).mockClear();
    (controller.confirm as jest.Mock).mockClear();
  });

  it('claim/start: 3 IPv6 DIFERENTES do MESMO /56 esgotam o max=3 — a 4ª (outro endereço do mesmo /56) é 429', async () => {
    const enderecos = ['2001:db8:1:1::40', '2001:db8:1:1::41', '2001:db8:1:1::42', '2001:db8:1:1::43'];
    for (let i = 0; i < 3; i++) {
      const ok = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', enderecos[i]).send({});
      expect(ok.status).toBe(200);
    }
    (controller.start as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/start').set('X-Forwarded-For', enderecos[3]).send({});
    expect(bloqueado.status).toBe(429);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('claim/confirm: 5 IPv6 DIFERENTES do MESMO /56 esgotam o max=5 — a 6ª (outro endereço do mesmo /56) é 429', async () => {
    const enderecos = [
      '2001:db8:1:1::50', '2001:db8:1:1::51', '2001:db8:1:1::52',
      '2001:db8:1:1::53', '2001:db8:1:1::54', '2001:db8:1:1::55',
    ];
    for (let i = 0; i < 5; i++) {
      const ok = await request(server).post('/api/auth/claim/confirm').set('X-Forwarded-For', enderecos[i]).send({});
      expect(ok.status).toBe(200);
    }
    (controller.confirm as jest.Mock).mockClear();
    const bloqueado = await request(server).post('/api/auth/claim/confirm').set('X-Forwarded-For', enderecos[5]).send({});
    expect(bloqueado.status).toBe(429);
    expect(controller.confirm).not.toHaveBeenCalled();
  });
});
