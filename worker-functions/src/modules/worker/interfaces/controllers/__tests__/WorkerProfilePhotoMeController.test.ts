/**
 * D815 — DELETE /api/workers/me/photo: a prestadora apaga a PRÓPRIA foto.
 * Identidade só pelo token; o workerId que apaga é o da ficha achada por findByAuthUid (segue merge),
 * nunca um id do corpo/params. Idempotente.
 */
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';
import { WorkerProfilePhotoMeController } from '../WorkerProfilePhotoMeController';
import { IWorkerRepository } from '../../../ports/IWorkerRepository';

function mkRes() {
  const res: Partial<Response> & { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function mkReq(uid?: string, extra: Record<string, unknown> = {}): Request {
  return { user: uid ? { uid } : undefined, body: {}, params: {}, ...extra } as unknown as Request;
}

describe('WorkerProfilePhotoMeController.remove', () => {
  let repo: { findByAuthUid: jest.Mock; clearProfilePhoto: jest.Mock };
  let ctrl: WorkerProfilePhotoMeController;

  beforeEach(() => {
    repo = {
      findByAuthUid: jest.fn().mockResolvedValue(Result.ok({ id: 'w-1' })),
      clearProfilePhoto: jest.fn().mockResolvedValue(Result.ok()),
    };
    ctrl = new WorkerProfilePhotoMeController(repo as unknown as IWorkerRepository);
  });

  it('apaga a foto da ficha do token e responde 200', async () => {
    const res = mkRes();
    await ctrl.remove(mkReq('uid-1'), res);
    expect(repo.findByAuthUid).toHaveBeenCalledWith('uid-1');
    expect(repo.clearProfilePhoto).toHaveBeenCalledWith('w-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { message: 'Profile photo removed' } });
  });

  it('ignora workerId do corpo e dos params (IDOR): só o do token apaga', async () => {
    const res = mkRes();
    await ctrl.remove(mkReq('uid-1', { body: { workerId: 'w-OUTRO' }, params: { id: 'w-OUTRO' } }), res);
    expect(repo.clearProfilePhoto).toHaveBeenCalledTimes(1);
    expect(repo.clearProfilePhoto).toHaveBeenCalledWith('w-1');
  });

  it('sem token: 401 e nada é apagado', async () => {
    const res = mkRes();
    await ctrl.remove(mkReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(repo.clearProfilePhoto).not.toHaveBeenCalled();
  });

  it('ficha não achada: 404 e nada é apagado', async () => {
    repo.findByAuthUid.mockResolvedValue(Result.ok(null));
    const res = mkRes();
    await ctrl.remove(mkReq('uid-1'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(repo.clearProfilePhoto).not.toHaveBeenCalled();
  });

  it('falha ao gravar: 500 sem vazar a mensagem do banco', async () => {
    repo.clearProfilePhoto.mockResolvedValue(Result.fail('boom db secret'));
    const res = mkRes();
    await ctrl.remove(mkReq('uid-1'), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('boom db secret');
  });
});
