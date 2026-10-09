/**
 * TactiqLinkController (spec 049 F4): o mapa serviço → HTTP. A resposta nunca carrega token; o callback sem Bearer volta
 * o navegador para a tela (ou JSON na stack); state inválido é 400 e o resto não é engolido.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn(() => ({ principal: { id: 'staff-uid-1' } })) } }));

import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { TactiqExchangeFailedError, TactiqStateInvalidError, type TactiqLinkService } from '../../../application/TactiqLinkService';
import { TactiqNotConfiguredError } from '../../../application/ports/TactiqPorts';
import { TactiqLinkController } from '../TactiqLinkController';

function res() {
  const r = {
    statusCode: 0, body: undefined as unknown, location: undefined as string | undefined,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    redirect(c: number, url: string) { r.statusCode = c; r.location = url; return r; },
  };
  return r as typeof r & Response;
}
const req = (o: Record<string, unknown>) => o as unknown as Request;
const withUser = { user: { email: 'Ana@Example.test' } };

function build() {
  const service = { getOwn: jest.fn(), startLink: jest.fn(), completeLink: jest.fn() };
  return { c: new TactiqLinkController(service as unknown as TactiqLinkService), service };
}

describe('TactiqLinkController', () => {
  afterEach(() => { delete process.env.TACTIQ_LINK_RETURN_URL; jest.clearAllMocks(); });

  it('GET: e-mail do token em minúsculas; sem e-mail → 400', async () => {
    const b = build();
    b.service.getOwn.mockResolvedValue({ status: 'linked', linkedAt: null, lastCheckAt: null, statusChangedAt: null });
    const r = res();
    await b.c.getOwn(req(withUser), r);
    expect(b.service.getOwn).toHaveBeenCalledWith('ana@example.test');
    expect(r.statusCode).toBe(200);
    const r2 = res();
    await b.c.getOwn(req({ user: {} }), r2);
    expect(r2.statusCode).toBe(400);
  });

  it('POST: devolve só a URL; ator e e-mail vêm do token; env faltando → 503; sem ator → 401', async () => {
    const b = build();
    b.service.startLink.mockResolvedValue({ authorizeUrl: 'https://tactiq.example/authorize?x=1' });
    const r = res();
    await b.c.start(req(withUser), r);
    expect(b.service.startLink).toHaveBeenCalledWith({ uid: 'staff-uid-1', email: 'ana@example.test' });
    expect(r.body).toEqual({ success: true, data: { authorizeUrl: 'https://tactiq.example/authorize?x=1' } });

    b.service.startLink.mockRejectedValueOnce(new TactiqNotConfiguredError('TACTIQ_OAUTH_CLIENT_ID'));
    const r2 = res();
    await b.c.start(req(withUser), r2);
    expect(r2.statusCode).toBe(503);
    expect(r2.body).toMatchObject({ code: 'TACTIQ_NOT_CONFIGURED' });

    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const r3 = res();
    await b.c.start(req(withUser), r3);
    expect(r3.statusCode).toBe(401);
  });

  it('A4-2: state inválido/adulterado → 400 com code estável', async () => {
    const b = build();
    b.service.completeLink.mockRejectedValue(new TactiqStateInvalidError());
    const r = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ code: 'TACTIQ_STATE_INVALID' });
  });

  it('callback sem code/state → 400 e o serviço nem é chamado', async () => {
    const b = build();
    const r = res();
    await b.c.callback(req({ query: { state: 's' } }), r);
    expect(r.statusCode).toBe(400);
    expect(b.service.completeLink).not.toHaveBeenCalled();
  });

  it('sucesso: com TACTIQ_LINK_RETURN_URL → 302 para a tela com ?tactiq=linked; sem a env → 200 JSON sem token', async () => {
    const b = build();
    b.service.completeLink.mockResolvedValue({ email: 'ana@example.test' });
    const r = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r);
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ana@example.test');

    process.env.TACTIQ_LINK_RETURN_URL = 'https://app.example.test/profile';
    const r2 = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r2);
    expect(r2.statusCode).toBe(302);
    expect(r2.location).toBe('https://app.example.test/profile?tactiq=linked');
  });

  it('troca recusada pelo Tactiq: 302 ?tactiq=error&reason=… com a env; 502 sem ela; erro inesperado → 500 relatado sem corpo', async () => {
    const b = build();
    b.service.completeLink.mockRejectedValue(new TactiqExchangeFailedError('invalid_grant'));
    const r = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r);
    expect(r.statusCode).toBe(502);
    expect(r.body).toMatchObject({ code: 'TACTIQ_EXCHANGE_FAILED', reason: 'invalid_grant' });

    process.env.TACTIQ_LINK_RETURN_URL = 'https://app.example.test/profile';
    const r2 = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r2);
    expect(r2.location).toBe('https://app.example.test/profile?tactiq=error&reason=invalid_grant');

    b.service.completeLink.mockRejectedValue(new Error('boom rt-segredo'));
    delete process.env.TACTIQ_LINK_RETURN_URL;
    const r3 = res();
    await b.c.callback(req({ query: { code: 'c', state: 's' } }), r3);
    expect(r3.statusCode).toBe(500);
    expect(JSON.stringify(r3.body)).not.toContain('segredo');
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'TactiqLinkController:callback' });
  });
});
