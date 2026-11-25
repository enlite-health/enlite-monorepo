/**
 * T-F3c-DB-14 (backend do painel) — `GET /api/admin/workers/:workerId/device/status` (spec 077, D795).
 * A rota exige a MESMA célula do botão (`worker_device:revoke`); a resposta é o que o banco diz, sem uid de operador.
 * O SQL contra Postgres real está em `tests/repo/workerDevicesRepository.repo.test.ts`.
 */
import express from 'express';
import request from 'supertest';
import { GetDeviceStatus } from '../GetDeviceStatus';
import { createAdminWorkerDeviceRoutes } from '../../interfaces/workerDeviceRoutes';
import { WorkerDeviceController } from '../../interfaces/controllers/WorkerDeviceController';
import { PermissionMiddleware } from '../../interfaces/middleware/PermissionMiddleware';
import type { PermissionClient, ResolvedAuthz } from '@modules/identity/permissions';
import type { WorkerDeviceRepository } from '../../ports/WorkerDeviceRepository';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const WORKER = '11111111-1111-4111-8111-111111111111';
const STATUS = {
  hasActiveDevice: false,
  lastOperatorRevocation: { revokedAt: '2026-11-24T12:00:00.000Z', wipedAt: null, requestedByName: 'Ana' },
};

function montar(permissions: string[]) {
  const repo = { findStatus: jest.fn().mockResolvedValue(STATUS) } as unknown as WorkerDeviceRepository;
  const controller = new WorkerDeviceController({ status: new GetDeviceStatus(repo) } as never);
  const authz: ResolvedAuthz = {
    uid: 'op-1', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'],
    groups: [{ id: 'g1', name: 'Recrutador' }], canSimulate: false, simulation: null,
  };
  const client = {
    resolve: jest.fn().mockResolvedValue(authz), can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn(),
  } as unknown as PermissionClient;
  const perm = new PermissionMiddleware({
    client,
    audit: { record: jest.fn() },
    env: { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.workers' },
  });
  const auth = { requireStaff: () => (req: express.Request, _r: unknown, next: express.NextFunction) => { req.authContext = { principal: { id: 'op-1', roles: ['recruiter'] } } as never; next(); } };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminWorkerDeviceRoutes(auth as never, perm, controller));
  return { app, repo };
}

describe('T-F3c-DB-14 status do aparelho (rota do painel)', () => {
  it('T-F3c-DB-14 sem a célula worker_device:revoke → 403 e o repositório não é lido; com a célula → 200 com o dado do banco', async () => {
    const sem = montar(['worker:read', 'worker:update']);
    await request(sem.app).get(`/api/admin/workers/${WORKER}/device/status`).expect(403);
    expect(sem.repo.findStatus).not.toHaveBeenCalled();

    // controle positivo: a MESMA rota, com a célula, chega ao repositório
    const com = montar(['worker_device:revoke']);
    const res = await request(com.app).get(`/api/admin/workers/${WORKER}/device/status`).expect(200);
    expect(com.repo.findStatus).toHaveBeenCalledWith(WORKER);
    expect(res.body).toEqual({ success: true, data: STATUS });
  });

  it('T-F3c-DB-14 a resposta não carrega uid de operador, id de instalação, chave nem token', async () => {
    const { app } = montar(['worker_device:revoke']);
    const res = await request(app).get(`/api/admin/workers/${WORKER}/device/status`).expect(200);
    const corpo = JSON.stringify(res.body);
    for (const proibido of ['revokedBy', 'revoked_by', 'installationId', 'publicKey', 'fcm', 'op-1']) expect(corpo).not.toContain(proibido);
  });

  it('T-F3c-DB-14 workerId inválido → 400 sem ler o banco', async () => {
    const { app, repo } = montar(['worker_device:revoke']);
    await request(app).get('/api/admin/workers/nao-e-uuid/device/status').expect(400);
    expect(repo.findStatus).not.toHaveBeenCalled();
  });
});
