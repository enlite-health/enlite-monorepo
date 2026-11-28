import type { Request } from 'express';
import { clientIp } from '../clientIp';

const req = (xff: string | string[] | undefined, ip?: string): Request =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip }) as unknown as Request;

describe('clientIp — último salto do X-Forwarded-For', () => {
  it('devolve o ÚLTIMO item, não o 1º (escrito pelo cliente)', () => {
    expect(clientIp(req('6.6.6.6, 1.2.3.4'))).toBe('1.2.3.4');
  });

  it('um item só devolve esse item', () => {
    expect(clientIp(req('1.2.3.4'))).toBe('1.2.3.4');
  });

  it('cabeçalho repetido (array) também vale o último', () => {
    expect(clientIp(req(['6.6.6.6', '7.7.7.7, 1.2.3.4']))).toBe('1.2.3.4');
  });

  it('sem XFF cai em req.ip', () => {
    expect(clientIp(req(undefined, '10.0.0.1'))).toBe('10.0.0.1');
  });

  it('XFF vazio ou só vírgulas cai em req.ip', () => {
    expect(clientIp(req(' , ', '10.0.0.2'))).toBe('10.0.0.2');
  });

  it('sem nada, "unknown"', () => {
    expect(clientIp(req(undefined, undefined))).toBe('unknown');
  });
});
