/**
 * AdminPresenceController — change 022-ux-mencao-e-notificacao, Rodada 2 (módulo
 * `@modules/presence` a partir de 22/09/2026). Unit puro (use case mockada, `req`/`res` fake) —
 * molde `AdminNotificationController` (implícito: mesma forma de 401 explícito quando
 * `principalUid` não resolve, 204 no caminho feliz).
 */
import type { Request, Response } from 'express';
import { AdminPresenceController } from '../AdminPresenceController';
import type { UpdatePresenceUseCase } from '../../../application/UpdatePresenceUseCase';

function fakeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('AdminPresenceController.heartbeat', () => {
  it('sem ator autenticado (principalUid null) — 401, nunca chama a use case', async () => {
    const execute = jest.fn();
    const controller = new AdminPresenceController({ execute } as unknown as UpdatePresenceUseCase);
    const req = { authContext: undefined, user: undefined } as unknown as Request;
    const res = fakeRes();

    await controller.heartbeat(req, res);

    expect(execute).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ator autenticado — chama a use case com o uid e devolve 204 sem corpo', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const controller = new AdminPresenceController({ execute } as unknown as UpdatePresenceUseCase);
    const req = { authContext: { principal: { id: 'uid-1' } } } as unknown as Request;
    const res = fakeRes();

    await controller.heartbeat(req, res);

    expect(execute).toHaveBeenCalledWith('uid-1');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
  });

  it('use case lança — 500, nunca vaza a mensagem interna', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('db explodiu'));
    const controller = new AdminPresenceController({ execute } as unknown as UpdatePresenceUseCase);
    const req = { authContext: { principal: { id: 'uid-1' } } } as unknown as Request;
    const res = fakeRes();

    await controller.heartbeat(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('db explodiu');
  });
});
