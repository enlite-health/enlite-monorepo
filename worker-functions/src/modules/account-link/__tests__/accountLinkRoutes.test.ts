/**
 * accountLinkRoutes — chave do rate limit por IP (`ipKey`).
 *
 * MORRE se o fallback voltar a usar `req.ip`/X-Forwarded-For cru: em IPv6 cada
 * cliente tem um /64 (às vezes /56) inteiro à disposição, então chave por
 * endereço exato deixa a mesma pessoa trocar de sufixo e furar o limite de
 * start/confirm do vínculo self-service (mesma régua do claim/OTP).
 */
import type { Request } from 'express';
import { ipKey } from '../accountLinkRoutes';

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
